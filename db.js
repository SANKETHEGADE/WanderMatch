"use strict";

/*
  A real, working database — it just happens to be a JSON file on disk
  instead of Postgres, since that's the storage choice for this build.
  Reads and writes the whole file per operation, which is perfectly
  fine at the concurrency level of a local demo server; it is NOT what
  you'd want under real multi-writer load, and that tradeoff is worth
  knowing about rather than discovering later.
*/

const fs = require("fs");
const path = require("path");

const DB_PATH = path.join(__dirname, "db.json");

function seedTrip(overrides) {
  return {
    id: overrides.id,
    name: overrides.name,
    destination: overrides.destination,
    start: overrides.start,
    end: overrides.end,
    isOpen: true,
    isSeed: true,
    interests: overrides.interests,
    pace: overrides.pace,
    budgetBand: overrides.budgetBand,
    version: 1,
    ownerId: null,
    members: [],
    days: Array.from({ length: dayCount(overrides.start, overrides.end) }, () => ({ items: [] })),
    proposals: [],
    confirmedProposalId: null,
    faceClusters: []
  };
}

function dayCount(start, end) {
  const days = Math.round((new Date(end) - new Date(start)) / 86400000) + 1;
  return Number.isFinite(days) && days > 0 ? days : 3;
}

const SEED_DB = {
  users: [],
  trips: [
    seedTrip({
      id: "manali-ridge-crew", name: "Manali Ridge Crew", destination: "Manali",
      start: "2027-03-10", end: "2027-03-15",
      interests: ["hiking", "photography", "food"], pace: "packed", budgetBand: "mid"
    }),
    seedTrip({
      id: "gokarna-beach-bums", name: "Gokarna Beach Bums", destination: "Gokarna",
      start: "2027-01-05", end: "2027-01-10",
      interests: ["beaches", "yoga", "food"], pace: "relaxed", budgetBand: "budget"
    }),
    seedTrip({
      id: "jaisalmer-desert-circuit", name: "Jaisalmer Desert Circuit", destination: "Jaisalmer",
      start: "2027-02-01", end: "2027-02-06",
      interests: ["history", "photography", "desert safari"], pace: "moderate", budgetBand: "mid"
    }),
    seedTrip({
      id: "mumbai-weekend-crew", name: "Mumbai Weekend Crew", destination: "Mumbai",
      start: "2027-04-01", end: "2027-04-03",
      interests: ["nightlife", "food", "shopping"], pace: "packed", budgetBand: "luxury"
    }),
    seedTrip({
      id: "munnar-tea-trail", name: "Munnar Tea Trail", destination: "Munnar",
      start: "2027-02-14", end: "2027-02-19",
      interests: ["hiking", "tea plantations", "photography"], pace: "moderate", budgetBand: "mid"
    })
  ]
};

function load() {
  if (!fs.existsSync(DB_PATH)) {
    save(SEED_DB);
    return structuredClone(SEED_DB);
  }
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
  } catch (error) {
    console.error("db.json was unreadable, reseeding:", error.message);
    save(SEED_DB);
    return structuredClone(SEED_DB);
  }
}

function save(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

module.exports = { load, save, dayCount };
