import { Module } from "@nestjs/common";
import { AiExplanationService } from "./ai-explanation.service.js";
import { AlertmanagerService } from "./alertmanager.service.js";
import { ApiKeysService } from "./api-keys.service.js";
import { AppController } from "./app.controller.js";
import { DatabaseService } from "./database.js";
import { DashboardController } from "./dashboard.controller.js";
import { DashboardSessionService } from "./dashboard-session.service.js";
import { DashboardService } from "./dashboard.service.js";
import { EventsService } from "./events.service.js";
import { IncidentDetectionService } from "./incident-detection.service.js";

@Module({ controllers: [AppController, DashboardController], providers: [DatabaseService, ApiKeysService, IncidentDetectionService, EventsService, AlertmanagerService, DashboardSessionService, AiExplanationService, DashboardService] })
export class AppModule {}
