// File move with hierarchy

function performsmartrule(records) {
  "use strict";

  const app = Application("DEVONthink");

  // ── Configuration ─────────────────────────────

  const config = {
    sourceRoot: "/_MailToArchive",
    destinationRoot: "/Email Archive",
    reviewRoot: "/Email Archive - Duplicate Review",

    previewOnly: false,
    duplicateHandling: "skip", // "skip" or "review"
    verifyTransfers: false
  };

  // ── Initialise ────────────────────────────────

  const destinationCache = new Map();
  const reviewCache = new Map();

  const stats = {
    archived: 0,
    duplicates: 0,
    reviewed: 0,
    noHash: 0,
    outsideSource: 0,
    groupsCreated: 0,
    errors: 0
  };

  const sourceMetadataCache = new Map();

  const sourceRoot = trimPath(config.sourceRoot);
  const destinationRoot = trimPath(config.destinationRoot);
  const reviewRoot = trimPath(config.reviewRoot);

  if (!["skip", "review"].includes(config.duplicateHandling)) {
    throw new Error("Invalid duplicateHandling setting.");
  }

  if (destinationRoot === sourceRoot ||
    destinationRoot.startsWith(sourceRoot + "/")) {
    throw new Error("Destination must be outside source.");
  }

  // ── Helpers ───────────────────────────────────

  function trimPath(path) {
    return path.replace(/\/+$/, "");
  }

  function normaliseHash(value) {
    if (value === null || value === undefined) return "";
    return String(value).trim().toLowerCase();
  }

  function relativeLocation(location) {
    const path = trimPath(location);

    if (path === sourceRoot) return "";

    if (!path.startsWith(sourceRoot + "/")) {
      return null;
    }

    return path.slice(sourceRoot.length + 1);
  }

  function joinPath(root, relative) {
    return relative ? root + "/" + relative : root;
  }

  function findGroup(path, db) {
    let group;

    try {
      group = app.getRecordAt(path, { in: db });
    } catch (_) {
      return null;
    }

    if (!group) return null;

    if (group.recordType() !== "group") {
      throw new Error("Not a group: " + path);
    }

    return group;
  }

  function ensureGroup(path, db) {
    const group = app.createLocation(path, { in: db });

    if (!group) {
      throw new Error("Could not create group: " + path);
    }

    stats.groupsCreated++;
    return group;
  }

  function getSourceMetadata(record) {
    // Identify the Smart Rule's matched record.
    const id = String(record.uuid());

    // Return cached metadata if available.
    if (sourceMetadataCache.has(id)) {
      return sourceMetadataCache.get(id);
    }

    // First encounter with this record's parent group:
    // bulk-load metadata for ALL its immediate children.
    const parent = record.locationGroup;

    const uuids = parent.children.uuid();
    const locations = parent.children.location();
    const hashes = parent.children.contentHash();

    // Do not risk mismatching parallel property arrays.
    if (uuids.length !== locations.length ||
      uuids.length !== hashes.length) {
      throw new Error(
        "Bulk source metadata lengths differ."
      );
    }

    for (let i = 0; i < uuids.length; i++) {
      sourceMetadataCache.set(String(uuids[i]), {
        location: locations[i],
        hash: hashes[i]
      });
    }

    const metadata = sourceMetadataCache.get(id);

    if (!metadata) {
      throw new Error(
        "Matched record not found in parent group."
      );
    }

    return metadata;
  }

  // Bulk-load existing hashes once per destination.
  function getDestination(path, db) {
    if (destinationCache.has(path)) {
      return destinationCache.get(path);
    }

    const group = findGroup(path, db);
    const hashes = new Set();

    if (group) {
      // Important: no parentheses after "children".
      // This is one bulk property request, not a
      // separate AppleEvent for every document.
      const existing = group.children.contentHash();

      for (const value of existing || []) {
        const hash = normaliseHash(value);
        if (hash) hashes.add(hash);
      }
    }

    const entry = { group, hashes };
    destinationCache.set(path, entry);

    return entry;
  }

  function getReviewGroup(path, db) {
    if (reviewCache.has(path)) {
      return reviewCache.get(path);
    }

    const group = ensureGroup(path, db);
    reviewCache.set(path, group);

    return group;
  }

  // Consolidate first, then move.
  function transferRecord(record, group) {
    // Consolidate — assume record is indexed
    const success = app.moveIntoDatabase({
      record: record
    });

    if (!success) {
      throw new Error("Move Into Database failed.");
    }

    // Move into destination group
    const moved = app.move({
      record: record,
      to: group
    });

    // Optional verification
    if (config.verifyTransfers) {
      if (moved.indexed()) {
        throw new Error("Record remains indexed.");
      }

      if (moved.locationGroup.uuid() !== group.uuid()) {
        throw new Error("Destination verification failed.");
      }
    }
  }

  // ── Process records ───────────────────────────

  for (const record of records) {
    let stage = "inspection";

    try {
      // ── Source metadata ───────────────────────

      stage = "loading source metadata";

      const metadata = getSourceMetadata(record);

      const relative = relativeLocation(metadata.location);

      if (relative === null) {
        stats.outsideSource++;
        continue;
      }

      const hash = normaliseHash(metadata.hash);

      if (!hash) {
        stats.noHash++;
        continue;
      }

      // ── Destination lookup ───────────────────

      const db = record.database;

      const destinationPath = joinPath(
        destinationRoot,
        relative
      );

      stage = "loading destination";

      const destination = getDestination(
        destinationPath,
        db
      );

      // ── Duplicate ─────────────────────────

      if (destination.hashes.has(hash)) {
        stats.duplicates++;

        if (config.duplicateHandling === "review") {
          if (!config.previewOnly) {
            stage = "filing duplicate";

            const reviewPath = joinPath(
              reviewRoot,
              relative
            );

            const reviewGroup = getReviewGroup(
              reviewPath,
              db
            );

            transferRecord(record, reviewGroup);
          }

          stats.reviewed++;
        }

        continue;
      }

      // ── Unique document ───────────────────

      if (!config.previewOnly) {
        stage = "archiving";

        if (!destination.group) {
          destination.group = ensureGroup(
            destinationPath,
            db
          );
        }

        transferRecord(record, destination.group);
      }

      // Only remember hashes after a successful
      // transfer (or a simulated preview transfer).
      destination.hashes.add(hash);
      stats.archived++;

    } catch (error) {
      stats.errors++;

      let errorName = "(unknown)";
      try {
        errorName = record.name();
      } catch (_) { }

		app.logMessage(
			"Archive error (" + stage + "): " + errorName + " — " + String(error)
		);
    }
  }

  // ── Summary ───────────────────────────────────

	const summary = [
		config.previewOnly ? "Email archive preview" : "Email archive complete",
		(config.previewOnly ? "Would archive: " : "Archived: ") + stats.archived,
		"Duplicates: " + stats.duplicates,
		(config.previewOnly ? "Would send to review: " : "Sent to review: ") + stats.reviewed,
		"Skipped (no hash): " + stats.noHash,
		"Skipped (outside source): " + stats.outsideSource,
		"Groups created: " + stats.groupsCreated,
		"Errors: " + stats.errors
	].join(" | ");

  app.logMessage(summary);
}
