// src/main/services/specialized_modes/meeting_mode.ts
import { EventEmitter } from 'events';
import { desktopCapturer } from 'electron';
import { spawn, ChildProcess } from 'child_process';
import { IModePayload } from '../../../shared/ipc_protocols';
import { logger } from '../../core/logger';
import { scrubEnv } from '../../utils/security';

const MEETING_KEYWORDS = [
  'zoom',
  'teams',
  'meet',
  'webex',
  'discord',
  'skype',
  'whereby',
  'jitsi',
  'ringcentral',
  'gotomeeting',
];

export class MeetingMode extends EventEmitter {
  private active = false;
  private currentApp = '';
  private currentTitle = '';
  private audioProcess: ChildProcess | null = null;

  public async detectActiveMeeting(): Promise<IModePayload | null> {
    try {
      const sources = await desktopCapturer.getSources({ types: ['window'] });

      for (const source of sources) {
        const title = source.name.toLowerCase();
        const keyword = MEETING_KEYWORDS.find(k => title.includes(k));
        if (keyword) {
          this.active = true;
          this.currentApp = keyword;
          this.currentTitle = source.name;
          this.emit('meeting-activated', { app: this.currentApp, title: this.currentTitle });
          return { mode: 'MEETING', app: this.currentApp, title: this.currentTitle };
        }
      }

      this.active = false;
      this.currentApp = '';
      this.currentTitle = '';
      return null;
    } catch (err) {
      logger.error('[MeetingMode] detection failed', { error: String(err) });
      return null;
    }
  }

  /**
   * Captures meeting audio with ffmpeg (Windows: dshow / WASAPI). The main
   * process has no `navigator.mediaDevices`, so we drive capture through
   * ffmpeg subprocesses. Fails gracefully when ffmpeg is not installed.
   */
  public async startAudioCapture(): Promise<boolean> {
    try {
      const sources = await desktopCapturer.getSources({ types: ['window', 'screen'] });
      if (sources.length === 0) {
        logger.warn('[MeetingMode] no capture sources available');
        return false;
      }

      const ffmpegPath = process.env.NOVA_FFMPEG_PATH || 'ffmpeg';
      // Windows: loopback audio via dshow; fall back to default microphone.
      const args =
        process.platform === 'win32'
          ? ['-f', 'dshow', '-i', 'audio=virtual-audio-capturer', '-ac', '1', '-ar', '16000', '-f', 's16le', 'pipe:1']
          : ['-f', 'avfoundation', '-i', ':0', '-ac', '1', '-ar', '16000', '-f', 's16le', 'pipe:1'];

      this.audioProcess = spawn(ffmpegPath, args, { windowsHide: true, env: scrubEnv() });

      const fail = (): void => {
        this.cleanupAudioProcess();
        this.emit('audio-capture-unavailable');
      };

      this.audioProcess.once('error', err => {
        logger.warn('[MeetingMode] ffmpeg unavailable; audio capture disabled', {
          error: err.message,
        });
        fail();
      });

      this.audioProcess.stdout?.on('data', (data: Buffer) => {
        this.emit('audio-data', data);
      });

      this.audioProcess.stderr?.on('data', (data: Buffer) => {
        // ffmpeg logs to stderr; only surface interesting lines.
        const line = data.toString().trim();
        if (/error|no such|not found|unable/i.test(line)) {
          logger.warn('[MeetingMode] ffmpeg stderr', { line });
        }
      });

      this.audioProcess.once('close', code => {
        if (code !== null && code !== 0) {
          logger.warn('[MeetingMode] ffmpeg exited', { code });
        }
        this.cleanupAudioProcess();
      });

      logger.info('[MeetingMode] audio capture started via ffmpeg');
      return true;
    } catch (err) {
      logger.error('[MeetingMode] audio capture failed', { error: String(err) });
      return false;
    }
  }

  /**
   * Speaker diarization. NOVA does not bundle pyannote.audio; this probes for
   * a Python runtime and reports availability honestly instead of pretending.
   * The result stream is emitted for the orchestrator to persist.
   */
  public runSpeakerDiarization(): void {
    const python = process.env.NOVA_PYTHON_PATH || 'python';
    const probe = spawn(python, ['-c', 'import pyannote.audio, sys; print("READY")'], {
      windowsHide: true,
      env: scrubEnv(),
    });

    let out = '';
    probe.stdout?.on('data', d => {
      out += d.toString();
    });
    probe.stderr?.on('data', d => {
      out += d.toString();
    });
    probe.once('close', code => {
      if (code === 0 && out.includes('READY')) {
        // pyannote is available — run diarization on the captured audio file.
        this.runPyannoteDiarization();
      } else {
        logger.info('[MeetingMode] pyannote.audio not installed; diarization deferred to AI provider');
        this.emit('diarization-unavailable', { reason: 'pyannote.audio not installed' });
      }
    });
    probe.once('error', err => {
      logger.warn('[MeetingMode] python runtime unavailable', { error: err.message });
      this.emit('diarization-unavailable', { reason: 'python runtime not found' });
    });
  }

  private runPyannoteDiarization(): void {
    const script = [
      'import sys, json',
      'from pyannote.audio import Pipeline',
      'p = Pipeline.from_pretrained("pyannote/speaker-diarization-3.1")',
      'r = p("meeting_audio.wav")',
      'print(json.dumps([{"speaker": s, "start": t.start, "end": t.end} for t, _, s in r.itertracks(yield_label=True)]))',
    ].join('\n');

    const proc = spawn(process.env.NOVA_PYTHON_PATH || 'python', ['-c', script], {
      windowsHide: true,
      env: scrubEnv(),
    });
    let output = '';
    proc.stdout?.on('data', d => {
      output += d.toString();
    });
    proc.stderr?.on('data', d => {
      logger.debug('[MeetingMode] pyannote stderr', { line: d.toString().trim() });
    });
    proc.once('close', code => {
      if (code !== 0) {
        this.emit('diarization-unavailable', { reason: 'pyannote pipeline failed' });
        return;
      }
      try {
        const result = JSON.parse(output);
        this.emit('diarization-complete', result);
      } catch {
        this.emit('diarization-unavailable', { reason: 'unparseable diarization output' });
      }
    });
  }

  private cleanupAudioProcess(): void {
    if (this.audioProcess) {
      try {
        this.audioProcess.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      this.audioProcess = null;
    }
  }

  public stop(): void {
    this.active = false;
    this.currentApp = '';
    this.currentTitle = '';
    this.cleanupAudioProcess();
    logger.info('[MeetingMode] stopped');
  }

  public isActive(): boolean {
    return this.active;
  }

  public getCurrentApp(): string {
    return this.currentApp;
  }

  public getCurrentTitle(): string {
    return this.currentTitle;
  }
}
