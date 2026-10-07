import { describe, expect, test } from "bun:test";
import { gate } from "../src/auth";

const req = (method: string, auth?: string) => new Request("https://x.test/transcode", { method, headers: auth ? { authorization: auth } : {} });

describe("transcode gate", () => {
  test("health is always open", () => {
    expect(gate(req("GET"), "/health", {})).toBeNull();
  });
  test("fails closed with no secret configured", () => {
    expect(gate(req("POST", "Bearer anything"), "/transcode", {})?.status).toBe(503);
    expect(gate(req("POST", "Bearer anything"), "/loudness", { TRANSCODE_TOKEN: "   " })?.status).toBe(503);
  });
  test("needs the right bearer token on POST", () => {
    const env = { TRANSCODE_TOKEN: "tok" };
    expect(gate(req("POST"), "/transcode", env)?.status).toBe(401);
    expect(gate(req("POST", "Bearer nope"), "/transcode", env)?.status).toBe(401);
    expect(gate(req("POST", "Bearer tok"), "/transcode", env)).toBeNull();
  });
  test("GET on the work routes is refused even with the token", () => {
    expect(gate(req("GET", "Bearer tok"), "/loudness", { TRANSCODE_TOKEN: "tok" })?.status).toBe(405);
  });
});
