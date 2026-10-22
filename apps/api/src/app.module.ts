import { Module } from "@nestjs/common";
import { ApiKeysService } from "./api-keys.service.js";
import { AppController } from "./app.controller.js";
import { DatabaseService } from "./database.js";
import { EventsService } from "./events.service.js";

@Module({ controllers: [AppController], providers: [DatabaseService, ApiKeysService, EventsService] })
export class AppModule {}
