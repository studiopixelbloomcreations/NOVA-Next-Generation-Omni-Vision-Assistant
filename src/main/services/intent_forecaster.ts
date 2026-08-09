// src/main/services/intent_forecaster.ts
import { EventEmitter } from 'events';

export interface IIntentPrediction {
  type: string;
  probability: number;
}

export class IntentForecaster extends EventEmitter {
  private chain: Map<string, Map<string, number>> = new Map();

  public recordTransition(fromType: string, toType: string): void {
    if (!this.chain.has(fromType)) {
      this.chain.set(fromType, new Map());
    }
    const fromMap = this.chain.get(fromType)!;
    fromMap.set(toType, (fromMap.get(toType) || 0) + 1);
  }

  public predictNext(currentType: string): IIntentPrediction[] {
    const fromMap = this.chain.get(currentType);
    if (!fromMap || fromMap.size === 0) return [];

    const total = Array.from(fromMap.values()).reduce((sum, count) => sum + count, 0);
    const predictions: IIntentPrediction[] = [];
    for (const [type, count] of fromMap) {
      predictions.push({
        type,
        probability: count / total,
      });
    }
    return predictions.sort((a, b) => b.probability - a.probability);
  }

  public shouldPreload(currentType: string): string | null {
    const predictions = this.predictNext(currentType);
    if (predictions.length > 0 && predictions[0].probability > 0.7) {
      return predictions[0].type;
    }
    return null;
  }
}

export const intentForecaster = new IntentForecaster();
