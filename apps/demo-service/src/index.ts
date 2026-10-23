import { createIncidentIQ } from "@incidentiq/node-sdk";
import { createDemoService } from "./service.js";

const apiKey = process.env.INCIDENTIQ_API_KEY;
if (!apiKey) throw new Error("INCIDENTIQ_API_KEY is required");

const incidentiq = createIncidentIQ({ apiKey, apiUrl: process.env.INCIDENTIQ_API_URL });
const port = Number(process.env.PORT ?? 4000);
const service = createDemoService(incidentiq);

service.listen(port, () => console.log(`Demo service listening on http://localhost:${port}`));

async function stop(): Promise<void> {
  service.close();
  await incidentiq.shutdown();
}

process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
