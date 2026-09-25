import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ConfigError, loadConfig } from "../src/config.ts";

const secret = "test-jwt-secret-not-production";

describe("configuration", () => {
  it("fails when DATABASE_URL is missing", () => {
    assert.throws(() => loadConfig({ NODE_ENV: "test", NEXUSFLOW_JWT_SECRET: secret }), ConfigError);
  });

  it("fails when the database URL is not postgres", () => {
    assert.throws(
      () => loadConfig({ NODE_ENV: "test", DATABASE_URL: "mysql://localhost/x", NEXUSFLOW_JWT_SECRET: secret }),
      /postgres/,
    );
  });

  it("fails closed in production without a JWT secret", () => {
    assert.throws(
      () =>
        loadConfig({
          NODE_ENV: "production",
          DATABASE_URL: "postgres://postgres@127.0.0.1:5432/nexusflow",
          NEXUSFLOW_AUTH_MODE: "hmac",
        }),
      /JWT/,
    );
  });

  it("rejects remote TLS disable in production", () => {
    assert.throws(
      () =>
        loadConfig({
          NODE_ENV: "production",
          DATABASE_URL: "postgres://postgres@db.example:5432/nexusflow",
          DATABASE_SSL: "disable",
          NEXUSFLOW_JWT_SECRET: secret,
        }),
      /DATABASE_SSL/,
    );
  });

  it("accepts a local test configuration", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      DATABASE_URL: "postgres://postgres@127.0.0.1:5432/nexusflow_test",
      NEXUSFLOW_JWT_SECRET: secret,
      JWT_ISSUER: "nexusflow-test",
      PORT: "0",
    });
    assert.equal(config.port, 0);
    assert.equal(config.databaseSsl, "disable");
    assert.equal(config.authMode, "hmac");
    assert.equal(config.matcherLockKey, "nexusflow:global-matcher");
    assert.equal(config.requiredSchemaVersion, "20260925120000_production_service");
  });
});
