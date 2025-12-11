import { CosmosClient } from "@azure/cosmos";
import { BlobServiceClient } from "@azure/storage-blob";
import cors from "cors";
import { randomUUID } from "crypto";
import dotenv from "dotenv";
import express from "express";
import multer from "multer";

dotenv.config();

const app = express();

// ======= ENV =======
const PORT = process.env.PORT || 8080;
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";

const AZURE_STORAGE_CONNECTION_STRING = process.env.AZURE_STORAGE_CONNECTION_STRING;
const BLOB_CONTAINER_NAME = process.env.BLOB_CONTAINER_NAME || "videos";

const COSMOS_ENDPOINT = process.env.COSMOS_ENDPOINT;
const COSMOS_KEY = process.env.COSMOS_KEY;
const COSMOS_DB_ID = process.env.COSMOS_DB_ID || "videoapp";
const COSMOS_CONTAINER_VIDEOS = process.env.COSMOS_CONTAINER_VIDEOS || "videos";

if (!AZURE_STORAGE_CONNECTION_STRING) {
    throw new Error("Missing AZURE_STORAGE_CONNECTION_STRING in environment variables.");
}
if (!COSMOS_ENDPOINT || !COSMOS_KEY) {
    throw new Error("Missing COSMOS_ENDPOINT or COSMOS_KEY in environment variables.");
}

// ======= Middleware =======
app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json({ limit: "2mb" }));

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 250 * 1024 * 1024 }, // 250MB (adjust if needed)
});

// ======= Azure Clients =======
const blobServiceClient = BlobServiceClient.fromConnectionString(
    AZURE_STORAGE_CONNECTION_STRING
);
const containerClient = blobServiceClient.getContainerClient(BLOB_CONTAINER_NAME);

const cosmosClient = new CosmosClient({ endpoint: COSMOS_ENDPOINT, key: COSMOS_KEY });

// We'll set these after ensuring resources
let videosContainer;

// ======= Helpers =======
const nowIso = () => new Date().toISOString();

function safeString(v, max = 200) {
    if (typeof v !== "string") return "";
    const s = v.trim();
    return s.length > max ? s.slice(0, max) : s;
}

function safeText(v, max = 800) {
    if (typeof v !== "string") return "";
    const s = v.trim();
    return s.length > max ? s.slice(0, max) : s;
}

// ======= Ensure Cosmos + Blob resources exist =======
async function ensureResources() {
    // Blob container
    await containerClient.createIfNotExists();

    // Cosmos DB + container
    const { database } = await cosmosClient.databases.createIfNotExists({
        id: COSMOS_DB_ID,
    });

    const { container } = await database.containers.createIfNotExists({
        id: COSMOS_CONTAINER_VIDEOS,
        partitionKey: { paths: ["/id"] }, // MUST match your container partition key
    });

    videosContainer = container;
}

// ======= Routes =======
app.get("/", (req, res) => {
    res.json({ name: "scalable-backend", ok: true, time: nowIso() });
});

app.get("/health", (req, res) => {
    res.json({ ok: true, time: nowIso() });
});

// List videos
app.get("/api/videos", async (req, res) => {
    try {
        const query = {
            query: `
        SELECT c.id, c.title, c.description, c.blobUrl, c.blobName, c.createdAt
        FROM c
        ORDER BY c.createdAt DESC
      `,
        };

        const { resources } = await videosContainer.items.query(query).fetchAll();
        res.json({ items: resources });
    } catch (err) {
        console.error("GET /api/videos:", err);
        res.status(500).json({ error: "Failed to fetch videos." });
    }
});

// Get one video (includes comments)
app.get("/api/videos/:id", async (req, res) => {
    try {
        const id = req.params.id;
        const { resource } = await videosContainer.item(id, id).read();
        if (!resource) return res.status(404).json({ error: "Video not found." });
        res.json(resource);
    } catch (err) {
        console.error("GET /api/videos/:id:", err);
        res.status(500).json({ error: "Failed to fetch video." });
    }
});

// Upload video
app.post("/api/videos", upload.single("video"), async (req, res) => {
    try {
        const title = safeString(req.body.title, 120);
        const description = safeString(req.body.description, 300);

        if (!title) return res.status(400).json({ error: "Title is required." });
        if (!req.file) return res.status(400).json({ error: "Video file is required." });

        const mime = req.file.mimetype || "application/octet-stream";
        if (!mime.startsWith("video/")) {
            return res.status(400).json({ error: "Please upload a valid video file." });
        }

        const id = randomUUID();
        const originalName = safeString(req.file.originalname, 120) || "video";
        const ext = originalName.includes(".") ? originalName.split(".").pop() : "mp4";
        const blobName = `${id}.${ext}`;

        const blockBlobClient = containerClient.getBlockBlobClient(blobName);

        await blockBlobClient.uploadData(req.file.buffer, {
            blobHTTPHeaders: { blobContentType: mime },
            metadata: { title, originalName },
        });

        // Direct blob URL (works if container is public OR you use SAS instead)
        const blobUrl = blockBlobClient.url;

        const doc = {
            id,
            title,
            description,
            blobName,
            blobUrl,
            createdAt: nowIso(),
            comments: [],
        };

        await videosContainer.items.create(doc);

        res.status(201).json(doc);
    } catch (err) {
        console.error("POST /api/videos:", err);
        res.status(500).json({
            error:
                "Upload failed. If your blob container is private, the video may not play via direct URL. Use public access or implement SAS URLs.",
        });
    }
});

// Add comment
app.post("/api/videos/:id/comments", async (req, res) => {
    try {
        const id = req.params.id;

        const userId = safeString(req.body.userId, 80);
        const authorName = safeString(req.body.authorName, 40) || "Anonymous";
        const text = safeText(req.body.text, 800);

        if (!userId) return res.status(400).json({ error: "userId is required." });
        if (!text) return res.status(400).json({ error: "Comment text is required." });

        const { resource } = await videosContainer.item(id, id).read();
        if (!resource) return res.status(404).json({ error: "Video not found." });

        const comment = {
            id: randomUUID(),
            userId,
            authorName,
            text,
            createdAt: nowIso(),
        };

        const updated = {
            ...resource,
            comments: Array.isArray(resource.comments)
                ? [comment, ...resource.comments]
                : [comment],
        };

        await videosContainer.item(id, id).replace(updated);
        res.status(201).json({ ok: true, comment });
    } catch (err) {
        console.error("POST /api/videos/:id/comments:", err);
        res.status(500).json({ error: "Failed to add comment." });
    }
});

// Delete own comment
app.delete("/api/videos/:id/comments/:commentId", async (req, res) => {
    try {
        const id = req.params.id;
        const commentId = req.params.commentId;
        const userId = safeString(req.body?.userId, 80);

        if (!userId) return res.status(400).json({ error: "userId is required." });

        const { resource } = await videosContainer.item(id, id).read();
        if (!resource) return res.status(404).json({ error: "Video not found." });

        const comments = Array.isArray(resource.comments) ? resource.comments : [];
        const target = comments.find((c) => c.id === commentId);
        if (!target) return res.status(404).json({ error: "Comment not found." });

        if (target.userId !== userId) {
            return res.status(403).json({ error: "You can delete only your own comments." });
        }

        const updated = {
            ...resource,
            comments: comments.filter((c) => c.id !== commentId),
        };

        await videosContainer.item(id, id).replace(updated);
        res.json({ ok: true });
    } catch (err) {
        console.error("DELETE /api/videos/:id/comments/:commentId:", err);
        res.status(500).json({ error: "Failed to delete comment." });
    }
});

// ======= Start =======
ensureResources()
    .then(() => {
        app.listen(PORT, () => console.log(`API running on port ${PORT}`));
    })
    .catch((e) => {
        console.error("Startup failed:", e);
        process.exit(1);
    });
