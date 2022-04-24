const {
  context,
  propagation,
} = require('@opentelemetry/api');
const { isObject, setSpanWithError } = require('./utils');

/**
 *
 * @param {call} original
 * @param {*[]} args
 * @param {dendenmushi} self
 * @returns
 */
function makeRpcClientRemoteCall(original, instrumentation, args, self) {
  function patchedCallback(span, callback) {
    const wrappedFn = (err, data) => {
      setSpanWithError(span, err);
      instrumentation._closeSpan(span);
      callback(err, data);
    }
    return context.bind(context.active(), wrappedFn);
  }

  return (span) => {
    const callbackIdx = args.findIndex(arg => typeof arg === 'function');
    if (callbackIdx >= 0) {
      args[callbackIdx] = patchedCallback(
        span,
        args[callbackIdx]
      );
    }

    let headers;
    if (callbackIdx === 2) {
      // 判断最后一位是不是 headers
      headers = isObject(args[3]) ? args[3] : {};
      args[3] = headers;
    } else {
      headers = isObject(args[2]) ? args[2] : {};
      args[2] = headers;
    }

    // 全链路跟踪，traceid 注入 headers
    propagation.inject(context.active(), headers, {
      set: (headers, k, v) => {
        headers[k] = v;
      },
    });

    const call = original.apply(self, args);

    return call;
  }
}

exports.makeRpcClientRemoteCall = makeRpcClientRemoteCall;
