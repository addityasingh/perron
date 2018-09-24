import {
  IncomingHttpHeaders,
  IncomingMessage,
  request as httpRequest
} from "http";
import { request as httpsRequest, RequestOptions } from "https";
import { Socket } from "net";
import * as querystring from "querystring";
import * as zlib from "zlib";

const DEFAULT_READ_TIMEOUT = 2000;
const DEFAULT_CONNECTION_TIMEOUT = 1000;

const getInterval = (time: [number, number]): number => {
  const diff = process.hrtime(time);
  return Math.round(diff[0] * 1000 + diff[1] / 1000000);
};

export interface ServiceClientRequestOptions extends RequestOptions {
  pathname: string;
  query?: object;
  timing?: boolean;
  body?: any;
  readTimeout?: number;
}

export class ServiceClientResponse {
  public timings?: Timings;
  public timingPhases?: TimingPhases;
  constructor(
    public statusCode: number,
    public headers: IncomingHttpHeaders,
    public body: any,
    // tslint:disable-next-line
    public request: ServiceClientRequestOptions
  ) {}
}

export interface Timings {
  lookup?: number;
  socket?: number;
  connect?: number;
  response?: number;
  end?: number;
}
export interface TimingPhases {
  wait?: number;
  dns?: number;
  tcp?: number;
  firstByte?: number;
  download?: number;
  total?: number;
}

export class ErrorWithTimings extends Error {
  constructor(
    originalError: Error,
    public timings: Timings,
    public timingPhases: TimingPhases
  ) {
    super(originalError.message);
  }
}

const subtract = (a?: number, b?: number): number | undefined => {
  if (typeof a === "number" && typeof b === "number") {
    return a - b;
  }
  return undefined;
};

const makeTimingPhases = (timings: Timings): TimingPhases => {
  return {
    wait: timings.socket,
    dns: subtract(timings.lookup, timings.socket),
    tcp: subtract(timings.connect, timings.lookup),
    firstByte: subtract(timings.response, timings.connect),
    download: subtract(timings.end, timings.response),
    total: timings.end
  };
};

export const request = (
  options: ServiceClientRequestOptions
): Promise<ServiceClientResponse> => {
  options = {
    protocol: "https:",
    ...options
  };

  if ("pathname" in options && !("path" in options)) {
    if ("query" in options) {
      options.path = `${options.pathname}?${querystring.stringify(
        options.query
      )}`;
    } else {
      options.path = options.pathname;
    }
  }

  // connection timeout - Happens when the socket connection cannot be established
  const connectionTimeout = options.timeout || DEFAULT_CONNECTION_TIMEOUT;
  /**
   * Read timeout - Happens after the socket connection is successfully established and
   * when there is no activity on the connected socket.
   */
  const readTimeout = options.readTimeout || DEFAULT_READ_TIMEOUT;

  const httpRequestFn =
    options.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, originalReject) => {
    let startTime: [number, number];
    let timings: Timings;
    let reject = originalReject;
    if (options.timing) {
      startTime = process.hrtime();
      timings = {
        lookup: undefined,
        socket: undefined,
        connect: undefined,
        response: undefined,
        end: undefined
      };
      reject = (error: Error) => {
        const errorWithTimings = new ErrorWithTimings(
          error,
          timings,
          makeTimingPhases(timings)
        );
        originalReject(errorWithTimings);
      };
    }

    const requestObject = httpRequestFn(options);

    function setReadTimeout() {
      requestObject.setTimeout(readTimeout, () => {
        requestObject.socket.destroy();
        reject(
          new Error(
            `Failed to read data within ${readTimeout} ms from ${options.host}`
          )
        );
      });
    }
    // Fires once the socket is assigned to a request
    requestObject.once("socket", (socket: Socket) => {
      if (options.timing) {
        timings.socket = getInterval(startTime);
      }
      if (socket.connecting) {
        socket.setTimeout(connectionTimeout, () => {
          // socket should be manually cleaned up
          socket.destroy();
          reject(
            new Error(
              `Could not connect within ${connectionTimeout} ms to ${
                options.host
              }`
            )
          );
        });
        if (options.timing) {
          socket.once("lookup", () => {
            timings.lookup = getInterval(startTime);
          });
        }
        // connect event would kick in only for new socket connection and not for
        // connections that are kept alive
        socket.once("connect", () => {
          if (options.timing) {
            timings.connect = getInterval(startTime);
          }
          setReadTimeout();
        });
      } else {
        if (options.timing) {
          timings.lookup = timings.socket;
          timings.connect = timings.socket;
        }
        setReadTimeout();
      }
    });

    requestObject.on("response", (response: IncomingMessage) => {
      if (options.timing) {
        if (timings.lookup === undefined) {
          timings.lookup = timings.socket;
        }
        if (timings.connect === undefined) {
          timings.connect = timings.socket;
        }
        timings.response = getInterval(startTime);
      }

      const { headers, statusCode } = response;
      let bodyStream;

      const encoding = headers && headers["content-encoding"];
      if (encoding === "gzip" || encoding === "deflate") {
        response.on("error", reject);
        bodyStream = response.pipe(zlib.createUnzip());
      } else {
        bodyStream = response;
      }

      let chunks: Buffer[] = [];
      let bufferLength = 0;

      bodyStream.on("error", reject);

      bodyStream.on("data", data => {
        bufferLength += data.length;
        chunks.push(data as Buffer);
      });

      bodyStream.on("end", () => {
        const body = Buffer.concat(chunks, bufferLength).toString("utf8");

        // to avoid leaky behavior
        chunks = [];
        bufferLength = 0;

        const serviceClientResponse = new ServiceClientResponse(
          statusCode || 0,
          headers,
          body,
          options
        );

        if (options.timing) {
          timings.end = getInterval(startTime);
          serviceClientResponse.timings = timings;
          serviceClientResponse.timingPhases = makeTimingPhases(timings);
        }
        resolve(serviceClientResponse);
      });
    });

    requestObject.on("error", reject);
    if (options.body) {
      requestObject.write(options.body);
    }
    requestObject.end();
  });
};
