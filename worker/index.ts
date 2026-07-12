import { Hono } from "hono";

export const app = new Hono();

app.get("/api/health", (context) => {
  return context.json({
    service: "music-library",
    status: "ok",
  });
});

app.notFound((context) => {
  return context.json(
    {
      error: "not_found",
    },
    404,
  );
});

export default app;
