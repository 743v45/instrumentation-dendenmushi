# OpenTelemetry dendenmushi Instrumentation for Node.js

## Supported Versions

- "^2.0.0"
- "^3.0.0"

## Usage

```javascript
const { DendenmushiInstrumentation } = require('@opentelemetry/instrumentation-dendenmushi');
const { ConsoleSpanExporter, SimpleSpanProcessor } = require('@opentelemetry/sdk-trace-base');
const { NodeTracerProvider } = require('@opentelemetry/sdk-trace-node');
const { registerInstrumentations } = require('@opentelemetry/instrumentation');

const provider = new NodeTracerProvider();

provider.addSpanProcessor(new SimpleSpanProcessor(new ConsoleSpanExporter()));
provider.register();

registerInstrumentations({
  instrumentations: [
    new DendenmushiInstrumentation(),
  ],
});
```
### Dendenmushi instrumentation Options

Dendenmushi instrumentation has few options available to choose from. You can set the following:

| Options                     | Type      | Description                                |
| --------------------------- | --------- | ------------------------------------------ |
| hostname                    | `string`  | Custom host name. (default to `localhost`) |
| requireParentforClientSpans | `boolean` | default to `false`                         |
| requireParentforServerSpans | `boolean` | default to `false`                         |
