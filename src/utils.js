const { SpanStatusCode } = require('@opentelemetry/api');
const attributeNames = require('./attributeNames');

/**
 * Sets the span with the error passed in params
 * @param {Span} span the span that need to be set
 * @param {Error} error error that will be set to span
 */
exports.setSpanWithError = (span, error) => {
  if (!error) return;
  const message = error.message;

  span.setAttributes({
    [attributeNames.RPC_ERROR_NAME]: error.name,
    [attributeNames.RPC_ERROR_MESSAGE]: message,
    [attributeNames.RPC_ERROR_STACK]: error.stack,
  });

  span.setStatus({ code: SpanStatusCode.ERROR, message });
};

exports.isObject = (val) => {
  return typeof val === 'object' &&
    !Array.isArray(val) &&
    val !== null;
};
