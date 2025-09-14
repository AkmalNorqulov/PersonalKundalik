// server.js
import express from "express";
import { chromium } from "playwright";
import dotenv from "dotenv";
import * as XLSX from "xlsx";
import cron from "node-cron";

dotenv.config();
const app = express();

let cachedSchedule = null;
let cacheDate = null;

// Helper: format date YYYY-MM-DD
const formatDate = (d) => d.toISOString().split("T")[0];

// Fetch schedule (same as before)
async function fetchSchedule() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto("https://login.emaktab.uz/", { waitUntil: "domcontentloaded" });
    await page.fill('input[name="login"]', process.env.EM_LOGIN);
    await page.fill('input[name="password"]', process.env.EM_PASSWORD);

    await Promise.all([
      page.click('input[type="submit"]'),
      page.waitForNavigation({ waitUntil: "networkidle" }),
    ]);

    await page.goto("https://emaktab.uz/marks", { waitUntil: "networkidle" });
    await page.click("div.nazuC");

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.click("a.tguZB"),
    ]);

    const stream = await download.createReadStream();
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const buffer = Buffer.concat(chunks);

    const workbook = XLSX.read(buffer, { type: "buffer" });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });

    let schedule = {};
    let currentDay = null;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (row[1] && typeof row[1] === "string") {
        if (["Dushanba", "Seshanba", "Chorshanba", "Payshanba", "Juma", "Shanba"].includes(row[1])) {
          currentDay = row[1];
          schedule[currentDay] = [];
        }
      }
      if (currentDay && row[1] && row[1] !== "Предмет") {
        schedule[currentDay].push(row[1]);
      }
    }

    const weekdayMap = {
      1: "Dushanba",
      2: "Seshanba",
      3: "Chorshanba",
      4: "Payshanba",
      5: "Juma",
      6: "Shanba",
    };

    const today = new Date();
    let todayNum = today.getDay();
    let tomorrowNum = (todayNum + 1) % 7;

    if (todayNum === 0) {
      todayNum = null;
      tomorrowNum = 1;
    }
    if (tomorrowNum === 0) tomorrowNum = 1;

    const todayName = todayNum ? weekdayMap[todayNum] : null;
    const tomorrowName = weekdayMap[tomorrowNum];

    const todayDate = formatDate(today);
    const tomorrowDate = formatDate(new Date(today.getTime() + 24 * 60 * 60 * 1000));

    const result = {
      today: {
        date: todayDate,
        subjects: todayName ? (schedule[todayName] || []) : [],
      },
      tomorrow: {
        date: tomorrowDate,
        subjects: schedule[tomorrowName] || [],
      },
    };

    return result;
  } finally {
    await browser.close();
  }
}

// Endpoint
app.get("/schedule", async (req, res) => {
  if (req.query.key !== process.env.DOWNLOAD_KEY) {
    return res.status(403).send("Forbidden");
  }

  try {
    const todayStr = formatDate(new Date());
    if (cachedSchedule && cacheDate === todayStr) {
      return res.json(cachedSchedule);
    }

    const newSchedule = await fetchSchedule();
    cachedSchedule = newSchedule;
    cacheDate = todayStr;

    res.json(newSchedule);
  } catch (err) {
    console.error("❌ Schedule retrieval failed:", err);
    res.status(500).send("Failed to retrieve schedule");
  }
});

app.use(express.static("public"));

// 🔔 Cron job: refresh every day at 06:00
cron.schedule("0 6 * * *", async () => {
  console.log("⏰ Running daily schedule refresh...");
  try {
    const newSchedule = await fetchSchedule();
    cachedSchedule = newSchedule;
    cacheDate = formatDate(new Date());
    console.log("✅ Daily schedule refreshed");
  } catch (err) {
    console.error("❌ Failed to refresh schedule:", err);
  }
});

app.listen(3000, () =>
  console.log("✅ Server running on http://localhost:3000")
);
