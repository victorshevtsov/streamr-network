import 'reflect-metadata'
import StreamrClient from '../../src'
import { Stream } from '../../src/Stream'
import { collect } from '../../src/utils/iterators'
import { FakeEnvironment } from '../test-utils/fake/FakeEnvironment'
import { createTestStream } from '../test-utils/utils'

describe('client destroy', () => {

    let client: StreamrClient
    let stream: Stream

    beforeEach(async () => {
        const environment = new FakeEnvironment()
        client = environment.createClient()
        stream = await createTestStream(client, module)
    })

    it('ongoing subscribe pipeline ends', async () => {
        const sub = await client.subscribe(stream.id)
        const onError: any = jest.fn()
        sub.on('error', onError)
        const outputPromise = collect(sub)
        await client.destroy()
        expect(onError).toBeCalledTimes(0)
        expect(await outputPromise).toEqual([])
    })

    it('unable to subscribe after destroy called', async () => {
        await client.destroy()
        await expect(async () => {
            await client.subscribe(stream.id)
        }).rejects.toThrow('Client is destroyed')
    })

    it('unable to publish after destroy called', async () => {
        await client.destroy()
        await expect(async () => {
            await client.publish(stream.id, {})
        }).rejects.toThrow(/Failed to publish.*Client is destroyed/)
    })
})