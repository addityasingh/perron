"use strict";

const assert = require("assert");
const sinon = require("sinon");
const proxyquire = require("proxyquire").noCallThru();
const EventEmitter = require("events");
const zlib = require("zlib");
const stream = require("stream");

class ResponseStub extends EventEmitter {}

class RequestStub extends EventEmitter {
  constructor() {
    super();
    this.setTimeout = sinon.stub();
  }
  end() {}
}

class SocketStub extends EventEmitter {
  constructor(connecting) {
    super();
    this.connecting = connecting;
    this.setTimeout = sinon.stub();
    this.destroy = sinon.stub();
  }
}

class BufferStream extends stream.Readable {
  constructor(buffer) {
    super();
    this.index = 0;
    this.buffer = buffer;
  }

  _read() {
    if (this.index >= this.buffer.length) {
      this.push(null);
      return;
    }
    this.push(this.buffer.slice(this.index, this.index + 1));
    this.index += 1;
  }
}

describe("request", () => {
  const httpStub = {};
  const httpsStub = {};

  let request = proxyquire("../dist/request", {
    http: httpStub,
    https: httpsStub
  }).request;
  let requestStub;
  let clock;

  beforeEach(() => {
    httpStub.request = sinon.stub();
    httpsStub.request = sinon.stub();
    requestStub = new RequestStub();
    httpsStub.request.returns(requestStub);
    clock = sinon.useFakeTimers();
  });

  afterEach(() => {
    clock.restore();
  });

  it("should call https if protocol is not specified", () => {
    request();
    assert.equal(httpsStub.request.callCount, 1);
  });

  it("should allow to call http if it is specified as protocol", () => {
    httpsStub.request.returns(undefined);
    httpStub.request.returns(requestStub);
    request({ protocol: "http:" });
    assert.equal(httpStub.request.callCount, 1);
  });

  it("should use pathname as path if none specified", () => {
    request({ pathname: "/foo" });
    assert.equal(httpsStub.request.firstCall.args[0].path, "/foo");
  });

  it("should prefer fully resolved path even if pathname is specified", () => {
    request({
      pathname: "/foo",
      path: "/bar"
    });
    assert.equal(httpsStub.request.firstCall.args[0].path, "/bar");
  });

  it("should allow to specify query params as an object", () => {
    request({
      query: {
        foo: "bar",
        buz: 42
      },
      pathname: "/"
    });
    assert.equal(httpsStub.request.firstCall.args[0].path, "/?foo=bar&buz=42");
  });

  it("should return a promise", () => {
    assert(typeof request().then, "function");
  });

  it("should reject a promise if request errors out", done => {
    request().catch(() => {
      done();
    });
    requestStub.emit("error");
  });

  it("should use the body of the request if one is provided", () => {
    requestStub.write = sinon.spy();
    request({
      body: "foobar"
    });
    assert.equal(requestStub.write.firstCall.args[0], "foobar");
  });

  it("should resolve the promise with full response on success", done => {
    request().then(response => {
      assert.equal(response.body, "foobar");
      done();
    });
    const responseStub = new ResponseStub();
    requestStub.emit("response", responseStub);
    responseStub.emit("data", Buffer.from("foo"));
    responseStub.emit("data", Buffer.from("bar"));
    responseStub.emit("end");
  });

  it("should reject the promise on response error", done => {
    request().catch(error => {
      assert.equal(error.message, "test");
      done();
    });
    const responseStub = new ResponseStub();
    requestStub.emit("response", responseStub);
    responseStub.emit("data", Buffer.from("foo"));
    responseStub.emit("error", new Error("test"));
  });

  it("should support responses chunked between utf8 boundaries", done => {
    request().then(response => {
      assert.equal(response.body, "я");
      done();
    });
    const responseStub = new ResponseStub();
    requestStub.emit("response", responseStub);
    const data = Buffer.from("я");
    responseStub.emit("data", Buffer.from([data[0]]));
    responseStub.emit("data", Buffer.from([data[1]]));
    responseStub.emit("end");
  });

  ["gzip", "deflate"].forEach(encoding => {
    it(`should inflate response body with ${encoding} encoding`, done => {
      request().then(response => {
        assert.equal(response.body, "foobar");
        assert.equal(response.statusCode, 200);
        assert.equal(response.headers["content-encoding"], "gzip");
        done();
      }, done);
      const responseStub = new BufferStream(zlib.gzipSync("foobar"));
      responseStub.statusCode = 200;
      responseStub.headers = {
        "content-encoding": "gzip"
      };
      requestStub.emit("response", responseStub);
    });
  });

  it("should reject the promise on unzip error", done => {
    request()
      .catch(error => {
        assert.equal(error.message, "incorrect header check");
        done();
      })
      .catch(done);
    const responseStub = new BufferStream(Buffer.from("not gzipped!"));
    responseStub.headers = {
      "content-encoding": "gzip"
    };
    requestStub.emit("response", responseStub);
  });

  it("should reject the promise on connection timeout", done => {
    const { timeout, host } = { timeout: 100, host: "b.com" };
    request({ timeout, host })
      .catch(error => {
        assert.equal(
          error.message,
          `Could not connect within ${timeout} ms to ${host}`
        );
        assert(socketStub.setTimeout.calledOnce);
        sinon.assert.calledWith(socketStub.setTimeout.firstCall, timeout);
        assert(socketStub.destroy.calledOnce);
        done();
      })
      .catch(done);

    const socketStub = new SocketStub(true);
    requestStub.emit("socket", socketStub);
    socketStub.setTimeout.invokeCallback();
  });

  it("should reject the promise on read timeout", done => {
    const { readTimeout, host } = { readTimeout: 200, host: "a.com" };
    request({ readTimeout, host })
      .catch(error => {
        assert.equal(
          error.message,
          `Failed to read data within ${readTimeout} ms from ${host}`
        );
        sinon.assert.calledWith(requestStub.setTimeout.firstCall, readTimeout);
        assert(requestStub.setTimeout.calledOnce);
        assert(requestStub.socket.destroy.calledOnce);
        done();
      })
      .catch(done);
    const socketStub = new SocketStub(false);
    requestStub.socket = socketStub;
    requestStub.emit("socket", socketStub);
    requestStub.setTimeout.invokeCallback();
  });

  it("should attach the request options to the response", done => {
    requestStub.abort = sinon.stub();
    const responseStub = new ResponseStub();
    const requestOptions = {
      test: "item"
    };
    request(requestOptions).then(response => {
      assert.equal(response.request.test, requestOptions.test);
      assert(!requestStub.abort.called);
      done();
    }, done);
    clock.tick(100);
    requestStub.emit("response", responseStub);
    clock.tick(100);
    responseStub.emit("end");
  });

  it("should record timings for non-keep-alive connection", done => {
    request({ timing: true }).then(response => {
      assert.deepEqual(response.timings, {
        socket: 10,
        lookup: 30,
        connect: 60,
        response: 100,
        end: 150
      });
      assert.deepEqual(response.timingPhases, {
        wait: 10,
        dns: 20,
        tcp: 30,
        firstByte: 40,
        download: 50,
        total: 150
      });
      done();
    }, done);
    const socketStub = new SocketStub(true);
    clock.tick(10);
    requestStub.emit("socket", socketStub);
    clock.tick(20);
    socketStub.emit("lookup");
    clock.tick(30);
    socketStub.emit("connect");
    clock.tick(40);
    const responseStub = new ResponseStub();
    requestStub.emit("response", responseStub);
    clock.tick(50);
    responseStub.emit("data", Buffer.from("hello"));
    responseStub.emit("end");
  });

  it("should record timings for keep-alive connection", done => {
    request({ timing: true }).then(response => {
      assert.deepEqual(response.timings, {
        socket: 10,
        lookup: 10,
        connect: 10,
        response: 30,
        end: 60
      });
      assert.deepEqual(response.timingPhases, {
        wait: 10,
        dns: 0,
        tcp: 0,
        firstByte: 20,
        download: 30,
        total: 60
      });
      done();
    }, done);
    const socketStub = new SocketStub(false);
    clock.tick(10);
    requestStub.emit("socket", socketStub);
    clock.tick(20);
    const responseStub = new ResponseStub();
    requestStub.emit("response", responseStub);
    clock.tick(30);
    responseStub.emit("data", Buffer.from("hello"));
    responseStub.emit("end");
  });

  it("should record timings for timeout", done => {
    const responseStub = new ResponseStub();
    request({ timing: true, readTimeout: 500, host: "c.com" })
      .catch(error => {
        assert.equal(
          error.message,
          "Failed to read data within 500 ms from c.com"
        );
        assert.deepEqual(error.timings, {
          lookup: 10,
          socket: 10,
          connect: 10,
          response: 100,
          end: undefined
        });
        assert.deepEqual(error.timingPhases, {
          wait: 10,
          dns: 0,
          tcp: 0,
          firstByte: 90,
          download: undefined,
          total: undefined
        });
        done();
      })
      .catch(done);
    const socketStub = new SocketStub(false);
    requestStub.socket = socketStub;
    clock.tick(10);
    requestStub.emit("socket", socketStub);
    clock.tick(90);
    requestStub.emit("response", responseStub);
    clock.tick(100);
    responseStub.emit("data", "hello");
    clock.tick(300);
    requestStub.setTimeout.invokeCallback();
  });
});
