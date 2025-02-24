import { StreamID, StreamMessage } from '@streamr/protocol'
import { scoped, Lifecycle, inject } from 'tsyringe'
import pLimit from 'p-limit'
import { StreamDefinition } from '../types'
import { StreamIDBuilder } from '../StreamIDBuilder'
import { Authentication, AuthenticationInjectionToken } from '../Authentication'
import { NetworkNodeFacade } from '../NetworkNodeFacade'
import { MessageFactory } from './MessageFactory'
import isString from 'lodash/isString'
import { StreamRegistryCached } from '../registry/StreamRegistryCached'
import { GroupKeyQueue } from './GroupKeyQueue'
import { Mapping } from '../utils/Mapping'
import { StreamrClientError } from '../StreamrClientError'
import { GroupKeyManager } from '../encryption/GroupKeyManager'

export interface PublishMetadata {
    timestamp?: string | number | Date
    partitionKey?: string | number
    msgChainId?: string
}

const parseTimestamp = (metadata?: PublishMetadata): number => {
    if (metadata?.timestamp === undefined) {
        return Date.now()
    } else {
        return metadata.timestamp instanceof Date
            ? metadata.timestamp.getTime()
            : isString(metadata.timestamp)
                ? new Date(metadata.timestamp).getTime()
                : metadata.timestamp
    }
}

@scoped(Lifecycle.ContainerScoped)
export class Publisher {

    private readonly messageFactories: Mapping<[streamId: StreamID], MessageFactory>
    private readonly groupKeyQueues: Mapping<[streamId: StreamID], GroupKeyQueue>
    private readonly streamIdBuilder: StreamIDBuilder
    private readonly authentication: Authentication
    private readonly streamRegistryCached: StreamRegistryCached
    private readonly node: NetworkNodeFacade
    private readonly concurrencyLimit = pLimit(1)

    constructor(
        streamIdBuilder: StreamIDBuilder,
        @inject(AuthenticationInjectionToken) authentication: Authentication,
        streamRegistryCached: StreamRegistryCached,
        groupKeyManager: GroupKeyManager,
        node: NetworkNodeFacade
    ) {
        this.streamIdBuilder = streamIdBuilder
        this.authentication = authentication
        this.streamRegistryCached = streamRegistryCached
        this.node = node
        this.messageFactories = new Mapping(async (streamId: StreamID) => {
            return this.createMessageFactory(streamId)
        })
        this.groupKeyQueues = new Mapping(async (streamId: StreamID) => {
            return GroupKeyQueue.createInstance(streamId, this.authentication, groupKeyManager)
        })
    }

    async publish<T>(
        streamDefinition: StreamDefinition,
        content: T,
        metadata?: PublishMetadata
    ): Promise<StreamMessage<T>> {
        const timestamp = parseTimestamp(metadata)
        /*
         * There are some steps in the publish process which need to be done sequentially:
         * - message chaining
         * - consuming a group key from a queue
         *
         * It is also good if messages are published to node in the same sequence (within
         * a message chain), as that can avoid unnecessary gap fills: if a subscriber would
         * receive messages m1, m2, m3 in order m1, m3, m2 it would try to get m2 via
         * a gap fill resend before it receives it normally).
         *
         * Currently we limit that there can be only one publish task at any given time.
         * That way message chaining and group keys consuming is done properly. If we want
         * to improve concurrency, we could maybe offload message encryptions to a separate
         * tasks which we'd execute in parallel.
         */
        return this.concurrencyLimit(async () => {
            const [ streamId, partition ] = await this.streamIdBuilder.toStreamPartElements(streamDefinition)
            try {
                const messageFactory = await this.messageFactories.get(streamId)
                const message = await messageFactory.createMessage(
                    content,
                    {
                        ...metadata,
                        timestamp
                    },
                    partition
                )
                await this.node.publishToNode(message)
                return message
            } catch (e) {
                const errorCode = (e instanceof StreamrClientError) ? e.code : 'UNKNOWN_ERROR'
                throw new StreamrClientError(`Failed to publish to stream ${streamId}. Cause: ${e.message}`, errorCode)
            }
        })
    }

    getGroupKeyQueue(streamId: StreamID): Promise<GroupKeyQueue> {
        return this.groupKeyQueues.get(streamId)
    }

    /* eslint-disable @typescript-eslint/no-shadow */
    private async createMessageFactory(streamId: StreamID): Promise<MessageFactory> {
        return new MessageFactory({
            streamId,
            authentication: this.authentication,
            streamRegistry: this.streamRegistryCached,
            groupKeyQueue: await this.groupKeyQueues.get(streamId)
        })
    }
}
