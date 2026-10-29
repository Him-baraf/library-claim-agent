import { createApp } from "./app";
import { config } from "./config";
const server = createApp().listen(config.port, config.host, () =>
  console.log(
    `Library Claim API: http://${config.host}:${config.port}. ${process.env.OPENAI_API_KEY ? "OpenAI key configured." : "No API key: frames and measurement work; AI unavailable."}`,
  ),
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => server.close(() => process.exit(0)));
