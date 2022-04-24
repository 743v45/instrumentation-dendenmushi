const {
  InstrumentationBase,
  InstrumentationNodeModuleDefinition,
  isWrapped,
  safeExecuteInTheMiddle,
} = require('@opentelemetry/instrumentation');
const {
  trace,
  context,
  diag,
  propagation,
  INVALID_SPAN_CONTEXT,
  ROOT_CONTEXT,
  SpanKind,
} = require('@opentelemetry/api');
const {
  SemanticAttributes,
} = require('@opentelemetry/semantic-conventions');
const {
  RPCType,
  setRPCMetadata,
} = require('@opentelemetry/core');
const {
  setSpanWithError,
} = require('./utils');
const { makeRpcClientRemoteCall } = require('./clientUtils');

const MODULE_NAME = '@upyun/dendenmushi';
const VERSION = require('../package.json').version;

class DendenmushiInstrumentation extends InstrumentationBase {
  constructor(config) {
    super(
      '@opentelemetry/instrumentation-dendenmushi',
      VERSION,
      Object.assign({}, config)
    );

    /** keep track on spans not ended */
    this._spanNotEnded = new WeakSet();
  }

  _startRpcSpan(name, options, ctx = context.active()) {
    const requireParent =
      options.kind === SpanKind.CLIENT
        ? this.getConfig().requireParentforClientSpans
        : this.getConfig().requireParentforServerSpans;

    const currentSpan = trace.getSpan(ctx);
    let span;

    if (requireParent === true && currentSpan === undefined) {
      span = trace.wrapSpanContext(INVALID_SPAN_CONTEXT);
    } else if (requireParent === true && currentSpan?.spanContext().isRemote) {
      span = currentSpan;
    } else {
      span = this.tracer.startSpan(name, options, ctx);
    }
    this._spanNotEnded.add(span);

    return span;
  }

  _closeSpan(span) {
    if (!this._spanNotEnded.has(span)) {
      return;
    }

    span.end();
    this._spanNotEnded.delete(span);
  }


  /**
   * set config
   * @param {object} [config = {}]
   * @param {?hostname} [config.hostname = "localhost"]
   */
  setConfig(config = {}) {
    this._config = Object.assign({
      hostname: 'localhost',
    }, config);
  }

  getConfig() {
    return this._config;
  }

  init() {
    return [
      new InstrumentationNodeModuleDefinition(
        MODULE_NAME,
        ['^2.0.0', '^3.0.0'],
        (moduleExports, moduleVersion) => {
          diag.debug(`Applying patch for ${MODULE_NAME}@${moduleVersion}`);
          if (isWrapped(moduleExports.Mushi.prototype.emit)) {
            this._unwrap(moduleExports.Mushi.prototype, 'emit');
          }
          this._wrap(
            moduleExports.Mushi.prototype,
            'emit',
            this._patchServerHandleFunction()
          );

          if (isWrapped(moduleExports.MushiClient.prototype.connect)) {
            this._unwrap(moduleExports.MushiClient.prototype, 'connect');
          }

          // 客户端连接
          this._wrap(
            moduleExports.MushiClient.prototype,
            'connect',
            this._patchClientConnection()
          )

          if (isWrapped(moduleExports.MushiClient.prototype.call)) {
            this._unwrap(moduleExports.MushiClient.prototype, 'call');
          }

          // 客户端调用 call
          this._wrap(
            moduleExports.MushiClient.prototype,
            'call',
            this._patchClientCall()
          )

          return moduleExports;
        },
        (moduleExports, moduleVersion) => {
          if (moduleExports === undefined) return;
          diag.debug(`Removing patch for ${MODULE_NAME}@${moduleVersion}`);
          this._unwrap(moduleExports.Mushi.prototype, 'emit');
          this._unwrap(moduleExports.MushiClient.prototype, 'connect');
          this._unwrap(moduleExports.MushiClient.prototype, 'call');

          return moduleExports;
        }
      )
    ];
  }


  /**
   * Get the patch for Mushi.handle function
   */
  _patchServerHandleFunction() {
    const instrumentation = this;

    return function(original) {
      instrumentation._diag.debug('patched dendenmushi server handle');

      return function serverHandle(event, ...args) {
        // 特定方法
        if (['MUSHI_DONE'].includes(event)) {
          return original.apply(this, [event, ...args]);
        }

        instrumentation._diag.debug(`Mushi instrumentation emit`);

        const req = args[0];
        const res = args[1];

        const headers = req.headers();
        const method = res._method;

        const spanOptions = {
          kind: SpanKind.SERVER,
          attributes: {
            [SemanticAttributes.RPC_SYSTEM]: MODULE_NAME,
            [SemanticAttributes.RPC_METHOD]: method,
          }
        };

        const ctx = propagation.extract(ROOT_CONTEXT, headers);
        const span = instrumentation._startRpcSpan(
          `MushiServer ${method}`,
          spanOptions,
          ctx
        );
        const rpcMetadata = {
          type: RPCType.HTTP,
          span,
        };

        const originalWrite = res._conn.write;
        res._conn.write = function(message) {
          res._conn.write = originalWrite;

          const returned = safeExecuteInTheMiddle(
            () => res._conn.write.apply(this, arguments),
            error => {
              if (error) {
                setSpanWithError(span, error);
                instrumentation._closeSpan(span);
                throw error;
              }
            }
          );

          const msgStatus = message?.[1];
          if (msgStatus === 'error') {
            setSpanWithError(span, {message: message?.[2]});
          }

          instrumentation._closeSpan(span);
          return returned;
        };

        return context.with(
          setRPCMetadata(trace.setSpan(ctx, span), rpcMetadata),
          () => {
            context.bind(context.active(), req);
            context.bind(context.active(), res);

            return safeExecuteInTheMiddle(
              () => original.apply(this, [event, ...args]),
              error => {
                if (error) {
                  setSpanWithError(span, error);
                  instrumentation._closeSpan(span);
                  throw error;
                }
              }
            );
          }
        );
      }
    }
  }

  _patchClientConnection() {
    return (original) => {
      this._diag.debug('set _patchClientConnection');
      return this._traceClientConnection(original);
    };
  }

  _traceClientConnection = (original) => {
    const instrumentation = this;
    return function() {
      instrumentation._diag.debug('start span for MushiClient.connect');

      const { host, port } = this._server;

      const attributes = {
        [SemanticAttributes.NET_HOST_NAME]: instrumentation.getConfig().hostname || 'localhost',
        [SemanticAttributes.NET_PEER_NAME]: host,
        [SemanticAttributes.NET_PEER_PORT]: port,
      };

      const spanOptions = {
        kind: SpanKind.CLIENT,
        attributes,
      };

      const span = instrumentation._startRpcSpan('MushiClient.connect', spanOptions);
      const newContext = trace.setSpan(context.active(), span);

      const args = Array.from(arguments);
      const callbackIdx = args.findIndex(arg => typeof arg === 'function');

      let haveCallback = false;
      // 仅第一个参数有效
      if (callbackIdx === 0) {
        haveCallback = true;
        arguments[callbackIdx] = function() {
          if (Array.from(arguments)[0]) {
            setSpanWithError(span, Array.from(arguments)[0]);
          }
          instrumentation._closeSpan(span);
          const callback = args[callbackIdx];
          return context.bind(newContext, callback).apply(this, arguments);
        };
      }

      try {
        const client = original.apply(this, arguments);
        if (!haveCallback) instrumentation._closeSpan(span);
        return client;
      } catch (error) {
        setSpanWithError(span, error);
        instrumentation._closeSpan(span);
        throw error;
      }
    };
  };

  _patchClientCall() {
    return (original) => {
      const instrumentation = this;
      return function clientCall() {
        const self = this;
        instrumentation._diag.debug('set _patchClientCall');
        const args = Array.from(arguments);


        const attributes = {
          [SemanticAttributes.NET_HOST_NAME]: instrumentation.getConfig().hostname || 'localhost',
          [SemanticAttributes.NET_PEER_NAME]: this._server.host,
          [SemanticAttributes.NET_PEER_PORT]: this._server.port,
          [SemanticAttributes.RPC_METHOD]: args[0],
        };

        const spanOptions = {
          kind: SpanKind.CLIENT,
          attributes,
        };

        const span = instrumentation._startRpcSpan(`MushiClient.call ${args[0]}`, spanOptions);

        return context.with(trace.setSpan(context.active(), span), () =>
          makeRpcClientRemoteCall(original, instrumentation, args, self)(span)
        );
      }
    }
  }
}

exports.DendenmushiInstrumentation = DendenmushiInstrumentation;
