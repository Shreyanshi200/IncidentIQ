import { createApp } from "./app.js";

const app = await createApp();
const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("PORT must be an integer between 1 and 65535");
app.enableShutdownHooks();
await app.listen(port);
