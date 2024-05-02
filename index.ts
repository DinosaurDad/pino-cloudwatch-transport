import {
  CloudWatchLogsClient,
  CreateLogGroupCommand,
  CreateLogStreamCommand,
  PutLogEventsCommand,
  ResourceAlreadyExistsException, ResourceNotFoundException
} from '@aws-sdk/client-cloudwatch-logs';
import pThrottle from 'p-throttle';
import build from 'pino-abstract-transport';
import {Mutex} from "async-mutex"

export interface PinoCloudwatchTransportOptions {
  logGroupName: string,
  logStreamName: string,
  logStreamNameRotationInterval?: number
  awsRegion?: string,
  awsAccessKeyId?: string,
  awsSecretAccessKey?: string,
  interval?: number
}
interface Log {
  timestamp: number,
  message: string
}

function isResourceAlreadyExistsException(err: unknown): err is ResourceAlreadyExistsException {
  if(err instanceof Error) {
    return err.name === 'ResourceAlreadyExistsException';
  }
  return false;
}

function isResourceNotFoundException(err: unknown): err is ResourceNotFoundException {
  if(err instanceof Error) {
    return err.name === 'ResourceNotFoundException';
  }
  return false;
}

export default async function (options: PinoCloudwatchTransportOptions) {

  const { logGroupName, logStreamName, awsRegion, awsAccessKeyId, awsSecretAccessKey } = options;
  const interval = options.interval || 1000;
  const logStreamNameRotationInterval = options.logStreamNameRotationInterval ?? 10*60*1000 // 10 mins default

  let credentials;

  if (awsAccessKeyId && awsSecretAccessKey) {
    credentials = {
      accessKeyId: awsAccessKeyId,
      secretAccessKey: awsSecretAccessKey
    }
  }

  const client = new CloudWatchLogsClient({ region: awsRegion, credentials });

  const logStreamMutex = new Mutex();
  let _logStreamName: string
  let rotationIntervalId: NodeJS.Timeout | null = null

  const nextLogStreamName = () => {
    const now = new Date();
    const year = now.getFullYear();
    const month = (now.getMonth() + 1).toString().padStart(2, '0');
    const day = now.getDate().toString().padStart(2, '0');
    const hour = now.getHours().toString().padStart(2, '0');
    const minute = now.getMinutes().toString().padStart(2, '0');
    // const second = now.getSeconds();
    const prefix = logStreamName ? `${logStreamName}-` : ""
    // const millisecond = now.getMilliseconds();
    return `${prefix}${year}-${month}-${day}-${hour}-${minute}`;
  }

  const rotateLogStreamName = async () => {
    await logStreamMutex.runExclusive(async () => {
      _logStreamName = nextLogStreamName()
      await createLogStream(logGroupName, _logStreamName);
    })
  }

  const rotate = async () => {
    if (_logStreamName) {
      await flush();
    }
    await rotateLogStreamName()
  }

  if (!logStreamNameRotationInterval) {
    await createLogStream(logGroupName, logStreamName);
  } else {
    await rotateLogStreamName()
    if (logStreamNameRotationInterval) {
      rotationIntervalId = setInterval(rotate, logStreamNameRotationInterval);
    }
  }

  const getLogStreamName = async () => {
    if (!_logStreamName) {
      return _logStreamName;
    } else {
      await logStreamMutex.waitForUnlock()
      return _logStreamName;
    }
  }

  const { addLog, getLogs, wipeLogs, addErrorLog, orderLogs } = (function() {
    let lastFlush = Date.now();

    // https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/cloudwatch_limits_cwl.html
    const MAX_EVENT_SIZE = (2 ** 10) * 256; // 256 Kb

    // https://docs.aws.amazon.com/AmazonCloudWatchLogs/latest/APIReference/API_PutLogEvents.html
    const MAX_BUFFER_LENGTH = 10_000;
    const MAX_BUFFER_SIZE = 1_048_576;

    const bufferedLogs: Log[] = [];


    function reachedNumberOfLogsLimit(): boolean {
      return bufferedLogs.length === MAX_BUFFER_LENGTH;
    }

    function reachedBufferSizeLimit(newLog: Log): boolean {
      const currentSize = bufferedLogs.reduce((acc, curr) => acc + curr.message.length + 26, 0);

      return (currentSize + newLog.message.length + 26) >= MAX_BUFFER_SIZE;
    }

    function logEventExceedsSize(log: Log): boolean {
      return log.message.length >= MAX_EVENT_SIZE;
    }

    function getLogs(): Log[] {
      return bufferedLogs;
    }

    function orderLogs(): void {
      getLogs().sort((a, b) => a.timestamp - b.timestamp);
    }

    function shouldDoAPeriodicFlush() {
      const now = Date.now();
      const timeSinceLastFlush = now - lastFlush;
      lastFlush = now;
      return timeSinceLastFlush > interval;
    }

    function addLog(log: Log): boolean {
      if(logEventExceedsSize(log)) {
        return false;
      }
      if(!reachedBufferSizeLimit(log)) {
        bufferedLogs.push(log);
        return reachedNumberOfLogsLimit() || shouldDoAPeriodicFlush();
      } else {
        setImmediate(() => {
          addLog(log);
        });
        return true;
      }
    }

    async function addErrorLog(errorLog: { message: string, error: string }) {
      const shouldFlush = addLog({
        timestamp: Date.now(),
        message: JSON.stringify(errorLog)
      });
      if(shouldFlush) {
        await flush();
      }
    }

    function wipeLogs(): void {
      bufferedLogs.length = 0; // TODO: is there a better/more performant way to wipe the array?
    }

    return { addLog, getLogs, wipeLogs, addErrorLog, orderLogs };
  })();

  // Initialization functions

  async function createLogGroup(logGroupName: string) {
    try {
      await client.send(new CreateLogGroupCommand({ logGroupName }))
    } catch (error: unknown) {
      if (isResourceAlreadyExistsException(error)) {
        return;
      } else {
        throw error;
      }
    }
  }

  async function createLogStream(logGroupName: string, logStreamName: string) {
    try {
      await client.send(new CreateLogStreamCommand({
        logGroupName,
        logStreamName
      }));
    } catch (error: unknown) {
      if (isResourceAlreadyExistsException(error)) {
        return;
      } else {
        throw error;
      }
    }
  }

  // Function for putting event logs

  async function putEventLogs(logGroupName: string, logStreamName: string , logEvents: Log[]) {
    if(logEvents.length === 0) return;
    const params = new PutLogEventsCommand({
      logEvents,
      logGroupName,
      logStreamName: `${logStreamName}`,
    })
    try {
      const output = await client.send(params);
    } catch (e) {
      console.error(e);
    }
  }

  const throttle = pThrottle({
    interval: 1000,
    limit: 1
  });

  const flush = throttle(async function() {
    try {
      orderLogs();
      const logStreamName = await getLogStreamName();
      await putEventLogs(logGroupName, logStreamName, getLogs());
    } catch (e: any) {
      await addErrorLog({ message: 'pino-cloudwatch-transport flushing error', error: e.message });
    } finally {
      wipeLogs();
    }
  });

  // Transport initialization

  try {
    console.log(`creating log group ${logGroupName}`)
    await createLogGroup(logGroupName);
    // await createLogStream(logGroupName, logStreamNamePrefix);
  } catch (e: any) {
    await addErrorLog({ message: 'pino-cloudwatch-transport initialization error', error: e.message });
  }


  return build(async function (source) {
    for await (const obj of source) {
      try{
        const shouldFlush = addLog(obj);
        if(shouldFlush) {
          await flush();
          source.emit('flushed');
        }
      } catch (e) {
        console.error('ERROR', e);
        throw e;
      }

    }
  }, {

    parseLine: (line) => {
      let value;
      try {
        value = JSON.parse(line); // TODO: what should be done on failure to parse?
      } catch (e) {
        value = '{}' ;
      }
      return {
        timestamp: value.time || Date.now(),
        message: line
      }
    },
    close: async () => {
      if (rotationIntervalId) {
        clearInterval(rotationIntervalId);
        rotationIntervalId = null
      }
      await flush();
      client.destroy();
    }
  })
}
