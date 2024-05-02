import 'dotenv/config';
import { Transform } from 'node:stream';
import { setImmediate } from 'timers/promises';
import { once } from 'node:events';
import pino from 'pino';
import pRetry, { AbortError } from 'p-retry';
import {describe, test, beforeEach, afterEach, afterAll, expect, vi} from "vitest"

import { CloudWatchLogsClient, DeleteLogGroupCommand, DeleteLogStreamCommand, GetLogEventsCommand, GetLogEventsCommandOutput } from '@aws-sdk/client-cloudwatch-logs';

import pinoCloudwatchTransport from '../index.js';

const AWS_REGION = process.env.AWS_REGION ?? "us-east-1";

const client = new CloudWatchLogsClient({ region: AWS_REGION })

const LOG_GROUP_NAME = 'pino-cloudwatch-transport';
const LOG_STREAM_NAME = 'pino-cloudwatch-transport-stream';
const LOG_STREAM_NAME_ROTATION_INTERVAL = 60*1000;

const RETRY_OPTIONS = { minTimeout: 100, factor: 2.5, retries: 10 };

async function sleep(ms: number) {
    return new Promise(resolve => {
        setTimeout(resolve, ms);
    });
}

function parseAndReturnMessages(output: GetLogEventsCommandOutput) {
    return output.events && output.events
        .map(event => JSON.parse(event.message ? event.message : 'null'))
        .filter(event => event);
}

async function getLogEventsOutput(before: number, after: number) {
    let output;
    try {
        output = await client.send(new GetLogEventsCommand({
            logGroupName: LOG_GROUP_NAME,
            logStreamName: LOG_STREAM_NAME,
            limit: 10,
            startTime: before,
            endTime: after }));
    } catch (e: unknown) {
        if(e instanceof Error) {
            throw new AbortError(`Client error ${e.message}`);
        }
        throw e;
    }

    if(output.events?.length === 0) throw new Error('Events have not been persisted yet.');
    return output;
}

let instance: Transform;

beforeEach(async () => {
    instance = await pinoCloudwatchTransport({
        logGroupName: LOG_GROUP_NAME,
        logStreamName: LOG_STREAM_NAME,
        logStreamNameRotationInterval: LOG_STREAM_NAME_ROTATION_INTERVAL,
        awsRegion: AWS_REGION
    });
});

afterEach(async () => {
    return
    await client.send(new DeleteLogStreamCommand({
        logGroupName: LOG_GROUP_NAME,
        logStreamName: LOG_STREAM_NAME
    }));
});

afterAll(async () => {
    return
    await client.send(new DeleteLogGroupCommand({
        logGroupName: LOG_GROUP_NAME
    }));

})

describe('Logging', async (t) => {
    test('Should be able to log a single line', async (t) => {
        const log = pino(instance);

        log.info("1-1")
        await sleep(1000)
        log.info("1-2")
        await sleep(500)
        log.info("1-3")
        await sleep(1000)
        log.info("1-4")
        await sleep(500)
        log.info("1-5")
        await sleep(1000)
        log.info("1-6")
        await sleep(500)
        log.info("1-7")
        await sleep(1000)
        log.info("1-8")

        // const before = Date.now();
        await setImmediate();

        await sleep(5000)

        // await sleep(LOG_STREAM_NAME_ROTATION_INTERVAL + 10000)

        log.info("2")

        await setImmediate();

        await sleep(2000)

        instance.end();

        await once(instance, 'close');

        // const after = Date.now();

        // const output = await pRetry(() => getLogEventsOutput(before, after), RETRY_OPTIONS);

        // const messages = parseAndReturnMessages(output);

        // expect(messages?.find((message) => {
        //     return message.msg === "1";
        // })).toBeTruthy();
    }, {timeout: LOG_STREAM_NAME_ROTATION_INTERVAL + 20000});

    test.skip('Should be able to log multiple lines', async (t) => {
        // t.plan(5);

        const log = pino(instance);
        const before = Date.now();


        // log.info(t.name);
        // log.info(t.name);
        // log.info(t.name);
        // log.info(t.name);
        log.info("1");
        log.info("2");

        await setImmediate();

        instance.end();

        await once(instance, 'close');

        const after = Date.now();

        const output = await pRetry(() => getLogEventsOutput(before, after), RETRY_OPTIONS);

        const messages = parseAndReturnMessages(output);

        // if (messages) {
        //     for(const message of messages) {
        //         t.equal(message.msg, t.name);
        //     }
        // }
    });


})

