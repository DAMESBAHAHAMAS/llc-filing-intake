import "dotenv/config";
import express from "express";
import { healthRouter } from "./routes/health.js";
import { sessionRouter } from "./routes/session.js";

const app = express();
app.use(express.json());
app.use(healthRouter);
app.use(sessionRouter);

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  console.log(`llc-data-spine listening on :${port}`);
});
