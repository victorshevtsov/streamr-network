import { EthereumAddress, keyToArrayIndex, Logger } from '@streamr/utils'
import { StreamPartID } from '@streamr/protocol'
import { Stream, StreamrClient } from 'streamr-client'
import { Diff, SetMembershipSynchronizer } from './SetMembershipSynchronizer'
import { StoragePoller } from './StoragePoller'
import { StorageEventListener } from './StorageEventListener'

const logger = new Logger(module)

export interface StorageConfigListener {
    onStreamPartAdded: (streamPart: StreamPartID) => void
    onStreamPartRemoved: (streamPart: StreamPartID) => void
}

/**
 * Manages the two data sources for storage node assignments (poll-based and
 * event-based), feeding the received full state and partial state updates to
 * `StorageAssignmentSynchronizer`. The state diffs produced by the
 * synchronizer are then further delivered to the user of this class via
 * listeners.
 *
 * The two data sources, heterogeneous in nature, are:
 *
 *  (1) Poll-based storage node assignments occurring on a scheduled interval
 *      (reliable, large payload, infrequent, may be stale)
 *
 *  (2) Event-based storage node assignments picked up in real-time
 *      (intermittent, small payload, frequent, up-to-date)
 *
 *  Event-based assignments are great for picking up on changes quickly.
 *  However, there is a risk of not receiving updates due to, e.g. connectivity
 *  issues. Therefore, if the real-time system fails, polling acts as a sort-of
 *  backup system.
 */
export class StorageConfig {
    private readonly listener: StorageConfigListener
    private readonly synchronizer = new SetMembershipSynchronizer<StreamPartID>()
    private readonly clusterSize: number
    private readonly myIndexInCluster: number
    private readonly storagePoller: StoragePoller
    private readonly storageEventListener: StorageEventListener
    private readonly abortController: AbortController

    constructor(
        clusterId: EthereumAddress,
        clusterSize: number,
        myIndexInCluster: number,
        pollInterval: number,
        streamrClient: StreamrClient,
        listener: StorageConfigListener
    ) {
        this.clusterSize = clusterSize
        this.myIndexInCluster = myIndexInCluster
        this.listener = listener
        this.storagePoller = new StoragePoller(clusterId, pollInterval, streamrClient, (streams, block) => {
            const streamParts = streams.flatMap((stream: Stream) => ([
                ...this.createMyStreamParts(stream)
            ]))
            this.handleDiff(this.synchronizer.ingestSnapshot(new Set<StreamPartID>(streamParts), block))
        })
        this.storageEventListener = new StorageEventListener(clusterId, streamrClient, (stream, type, block) => {
            const streamParts = this.createMyStreamParts(stream)
            this.handleDiff(this.synchronizer.ingestPatch(streamParts, type, block))
        })
        this.abortController = new AbortController()
    }

    async start(): Promise<void> {
        await Promise.all([
            this.storagePoller.start(this.abortController.signal),
            this.storageEventListener.start()
        ])
    }

    async destroy(): Promise<void> {
        this.abortController.abort()
        await this.storageEventListener.destroy()
    }

    hasStreamPart(streamPart: StreamPartID): boolean {
        return this.getStreamParts().has(streamPart)
    }

    getStreamParts(): ReadonlySet<StreamPartID> {
        return this.synchronizer.getState()
    }

    private createMyStreamParts(stream: Stream): Set<StreamPartID> {
        return new Set<StreamPartID>(stream.getStreamParts().filter((streamPart) => {
            const hashedIndex = keyToArrayIndex(this.clusterSize, streamPart)
            return hashedIndex === this.myIndexInCluster
        }))
    }

    private handleDiff({ added, removed }: Diff<StreamPartID>): void {
        added.forEach((streamPart) => this.listener.onStreamPartAdded(streamPart))
        removed.forEach((streamPart) => this.listener.onStreamPartRemoved(streamPart))
        logger.info('Updated state', {
            added,
            removed
        })
    }
}
