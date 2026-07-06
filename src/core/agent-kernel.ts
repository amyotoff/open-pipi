import { getSpace } from '../db';
import { MaterializedAgent } from './pack-types';
import { materializeAgentForPack } from './assistant-pack';
import { loadPackFromRoot } from './pack-loader';
import { ensureSpaceBehaviorSnapshot, getSpacePackSnapshotRoot } from './space-behavior';

export function materializeAgent(input: { packId?: string; spaceId?: string }): MaterializedAgent {
    const packId = input.packId || (input.spaceId ? getSpace(input.spaceId)?.assistant_pack_id : undefined) || 'jeeves';
    return materializeAgentForPack(packId);
}

export function materializeAgentForSpace(spaceId: string): MaterializedAgent {
    ensureSpaceBehaviorSnapshot(spaceId);
    const snapshotRoot = getSpacePackSnapshotRoot(spaceId);
    if (snapshotRoot) {
        return loadPackFromRoot(snapshotRoot) || materializeAgent({ spaceId });
    }

    return materializeAgent({ spaceId });
}
