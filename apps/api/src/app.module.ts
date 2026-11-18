import { Module } from "@nestjs/common";
import { AlertmanagerService } from "./alertmanager.service.js";
import { ApiKeysService } from "./api-keys.service.js";
import { AppController } from "./app.controller.js";
import { DatabaseService } from "./database.js";
import { EventsService } from "./events.service.js";

@Module({ controllers: [AppController], providers: [DatabaseService, ApiKeysService, EventsService, AlertmanagerService] })
export class AppModule {}
