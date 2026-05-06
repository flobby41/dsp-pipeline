import express from "express";

import uploadRouter from "./routes/upload.js";

const app = express();

app.use(express.json({ limit: "2mb" }));
app.use("/upload", uploadRouter);

const port = Number(process.env.PORT ?? process.env.API_PORT ?? "3001");

app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`API listening on http://localhost:${port}`);
});

