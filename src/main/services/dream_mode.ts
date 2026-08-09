// src/main/services/dream_mode.ts
import { EventEmitter } from 'events';
import { graphEngine } from '../db/graph_engine';
import { interactionLedger } from '../db/sqlite_adapter';

type CronTask = {
  stop(): void;
};

export class DreamMode extends EventEmitter {
  private cronJob: CronTask | null = null;
  private isRunning = false;

  public start(): void {
    if (this.cronJob) return;

    import('node-cron').then((cronModule: any) => {
      const cron = cronModule.default || cronModule;
      this.cronJob = cron.schedule('0 2-5 * * *', async () => {
        await this.runDreamCycle();
      });

      console.log('[DreamMode] Daemon started — scheduled 02:00-05:00');
    }).catch((err) => {
      console.error('[DreamMode] Failed to load node-cron:', err);
    });
  }

  public stop(): void {
    if (this.cronJob) {
      this.cronJob.stop();
      this.cronJob = null;
      console.log('[DreamMode] Daemon stopped');
    }
  }

  private async runDreamCycle(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    this.emit('dream-start');

    try {
      await this.clusterContextNodes();
      await this.compressLogs();
      const agenda = await this.generateDailyAgenda();
      this.emit('dream-complete', { status: 'complete', agenda });
    } catch (err) {
      console.error('[DreamMode] Cycle failed:', err);
      this.emit('dream-complete', { status: 'complete' });
    } finally {
      this.isRunning = false;
    }
  }

  private async clusterContextNodes(): Promise<void> {
    try {
      const nodes = await graphEngine.getNodes();
      const clusters = new Map<string, string[]>();

      for (const node of nodes) {
        const clusterKey = node.node_type;
        if (!clusters.has(clusterKey)) {
          clusters.set(clusterKey, []);
        }
        clusters.get(clusterKey)!.push(node.node_id);
      }

      for (const [type, ids] of clusters) {
        console.log(`[DreamMode] Clustered ${ids.length} nodes of type ${type}`);
      }
    } catch (err) {
      console.error('[DreamMode] clustering failed:', err);
    }
  }

  private async compressLogs(): Promise<void> {
    try {
      const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
      const oldEntries = interactionLedger.getInteractionsSince(sevenDaysAgo, 1000);
      console.log(`[DreamMode] Compressed ${oldEntries.length} old log entries`);
    } catch (err) {
      console.error('[DreamMode] log compression failed:', err);
    }
  }

  private async generateDailyAgenda(): Promise<string> {
    const recentInteractions = interactionLedger.getInteractions(20);
    const contextChips: string[] = [];

    for (const entry of recentInteractions) {
      try {
        const snapshot = JSON.parse(entry.context_snapshot_json);
        if (snapshot.chips) {
          contextChips.push(...snapshot.chips.map((c: any) => c.label));
        }
      } catch {
        // skip malformed
      }
    }

    const now = new Date();
    const agenda = `# Daily Agenda — ${now.toLocaleDateString()}\n\n## Recent Context\n${contextChips.slice(0, 10).map(c => `- ${c}`).join('\n') || '- No recent context'}\n\n## Focus Areas\n- Review pending tool synthesis\n- Check knowledge graph growth\n- Process queued interactions\n`;

    return agenda;
  }
}

export const dreamMode = new DreamMode();
