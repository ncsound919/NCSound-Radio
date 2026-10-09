-- CreateTable
CREATE TABLE "Artist" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "city" TEXT,
    "state" TEXT,
    "instagram" TEXT,
    "soundcloud" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Submission" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "artistName" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "trackTitle" TEXT NOT NULL,
    "genre" TEXT NOT NULL,
    "explicit" BOOLEAN NOT NULL DEFAULT false,
    "city" TEXT,
    "state" TEXT,
    "socials" TEXT,
    "fileName" TEXT,
    "fileSize" INTEGER,
    "notes" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "agreementVersion" TEXT NOT NULL DEFAULT 'v1.1',
    "agreementAcceptedAt" DATETIME,
    "agreementIp" TEXT,
    "reviewNotes" TEXT,
    "reviewedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Sponsor" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "contact" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "monthlyRate" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "startAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endAt" DATETIME
);

-- CreateTable
CREATE TABLE "Campaign" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sponsorId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "spotsPerDay" INTEGER NOT NULL DEFAULT 6,
    "creativeName" TEXT NOT NULL,
    "startAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endAt" DATETIME,
    "active" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "Campaign_sponsorId_fkey" FOREIGN KEY ("sponsorId") REFERENCES "Sponsor" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AdPlay" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "campaignId" TEXT NOT NULL,
    "playedAt" DATETIME NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'program-clock',
    CONSTRAINT "AdPlay_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Show" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "dayOfWeek" INTEGER NOT NULL,
    "startHour" INTEGER NOT NULL,
    "startMinute" INTEGER NOT NULL DEFAULT 0,
    "durationMin" INTEGER NOT NULL,
    "explicit" BOOLEAN NOT NULL DEFAULT false,
    "kind" TEXT NOT NULL DEFAULT 'PLAYLIST',
    "accent" TEXT NOT NULL DEFAULT 'amber',
    "active" BOOLEAN NOT NULL DEFAULT true
);

-- CreateTable
CREATE TABLE "Track" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "artist" TEXT NOT NULL,
    "album" TEXT,
    "durationSec" INTEGER NOT NULL,
    "explicit" BOOLEAN NOT NULL DEFAULT false,
    "playlist" TEXT NOT NULL,
    "bpm" INTEGER,
    "isrc" TEXT,
    "label" TEXT,
    "seedOrder" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "PlayLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "trackId" TEXT NOT NULL,
    "playedAt" DATETIME NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'AUTODJ',
    CONSTRAINT "PlayLog_trackId_fkey" FOREIGN KEY ("trackId") REFERENCES "Track" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TrackRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "trackId" TEXT NOT NULL,
    "listenerName" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TrackRequest_trackId_fkey" FOREIGN KEY ("trackId") REFERENCES "Track" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "StationSetting" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL
);

-- CreateIndex
CREATE INDEX "Submission_status_idx" ON "Submission"("status");

-- CreateIndex
CREATE INDEX "AdPlay_playedAt_idx" ON "AdPlay"("playedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AdPlay_campaignId_playedAt_key" ON "AdPlay"("campaignId", "playedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Show_slug_key" ON "Show"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Track_seedOrder_key" ON "Track"("seedOrder");

-- CreateIndex
CREATE INDEX "PlayLog_playedAt_idx" ON "PlayLog"("playedAt");

-- CreateIndex
CREATE UNIQUE INDEX "PlayLog_trackId_playedAt_key" ON "PlayLog"("trackId", "playedAt");

-- CreateIndex
CREATE INDEX "TrackRequest_createdAt_idx" ON "TrackRequest"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "TrackRequest_trackId_listenerName_key" ON "TrackRequest"("trackId", "listenerName");
