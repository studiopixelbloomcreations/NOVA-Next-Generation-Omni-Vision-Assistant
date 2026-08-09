// src/main/services/life_replay.ts
import { EventEmitter } from 'events';
import { interactionLedger } from '../db/sqlite_adapter';
import { graphEngine } from '../db/graph_engine';
import { IInteractionLedgerEntry } from '../../shared/ipc_protocols';

export interface ILifeReplayTimelineItem {
  timestamp: number;
  type: string;
  input: string;
  output: string;
}

export class LifeReplay extends EventEmitter {
  public queryByContext(snapshotJson: string): IInteractionLedgerEntry[] {
    return interactionLedger.getInteractionsByContext(snapshotJson);
  }

  public async fuseWithVisualSearch(queryText: string, k: number = 5): Promise<IInteractionLedgerEntry[]> {
    const similarNodes = await graphEngine.searchSimilarNodes(queryText, k);
    const interactions: IInteractionLedgerEntry[] = [];
    for (const node of similarNodes) {
      const sinceEpoch = (node as any).created_at || 0;
      const entries = interactionLedger.getInteractionsSince(sinceEpoch, 50);
      interactions.push(...entries);
    }
    return interactions;
  }

  public buildTimeline(interactions: IInteractionLedgerEntry[]): ILifeReplayTimelineItem[] {
    return interactions
      .map(entry => ({
        timestamp: entry.timestamp_epoch,
        type: entry.interaction_type,
        input: entry.raw_transcript_input,
        output: entry.model_response_output,
      }))
      .sort((a, b) => a.timestamp - b.timestamp);
  }

  public async queryAndBuildTimeline(snapshotJson: string): Promise<ILifeReplayTimelineItem[]> {
    const entries = this.queryByContext(snapshotJson);
    const timeline = this.buildTimeline(entries);
    this.emit('timeline-ready', timeline);
    return timeline;
  }
}

export const lifeReplay = new LifeReplay();
