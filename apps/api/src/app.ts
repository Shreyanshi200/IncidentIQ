import "reflect-metadata";
import { type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";

export function createApp(): Promise<INestApplication> {
  return NestFactory.create(AppModule, { logger: false });
}
