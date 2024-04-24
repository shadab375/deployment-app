require('dotenv').config()

const { exec } = require("child_process");
const path = require("path");
const fs = require("fs");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const mime = require("mime-types");
const { Kafka } = require('kafkajs')
// const Redis = require("ioredis");

// const publisher = new Redis(process.env.REDIS_CONNECTION_STRING);

const s3Client = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET,
  },
});

const PROJECT_ID = process.env.PROJECT_ID;
const DEPLOYEMENT_ID = process.env.DEPLOYEMENT_ID;

const kafka = new Kafka({
  clientId: `docker-build-server-${DEPLOYEMENT_ID}`,
  brokers: [process.env.KAFKA_BROKER_ID],
  ssl: {
      ca: [fs.readFileSync(path.join(__dirname, 'kafka.pem'), 'utf-8')]
  },
  sasl: {
      username: process.env.KAFKA_USERNAME,
      password: process.env.KAFKA_PASSWORD,
      mechanism: 'plain'
  }
})

const producer = kafka.producer()

async function publishLog(log) {
    await producer.send({ topic: `container-logs`, 
                          messages: [{ key: 'log', 
                                       value: JSON.stringify({ PROJECT_ID, DEPLOYEMENT_ID, log }) }] })
}

async function init() {

  await producer.connect()

  console.log("Executing script.js");
  await publishLog("Build Started...");
  const outDirPath = path.join(__dirname, "output");

  const p = exec(`cd ${outDirPath} && npm install && npm run build`);

  p.stdout.on("data", async function (data) {
    console.log(data.toString());
    await publishLog(data.toString());
  });

  p.stdout.on("error", async function (data) {
    console.log("Error", data.toString());
    await publishLog(`error: ${data.toString()}`);
  });

  p.on("close", async function () {
    console.log("Build Complete");
    await publishLog(`Build Complete`);
    const distFolderPath = path.join(__dirname, "output", "dist");

    // Check if the directory exists, if not, create it
    if (!fs.existsSync(distFolderPath)){
        fs.mkdirSync(distFolderPath, { recursive: true });
    }

    const distFolderContents = fs.readdirSync(distFolderPath, {
      recursive: true,
    });

    await publishLog(`Starting to upload`);
 
    for (const file of distFolderContents) {
      const filePath = path.join(distFolderPath, file);
      if (fs.lstatSync(filePath).isDirectory()) continue;

      console.log("uploading", filePath);
      await publishLog(`uploading ${file}`);

      const command = new PutObjectCommand({
        Bucket: "sht-deployment-bucket",
        Key: `__outputs/${PROJECT_ID}/${file}`,
        Body: fs.createReadStream(filePath),
        ContentType: mime.lookup(filePath),
      });

      await s3Client.send(command);
      await publishLog(`uploaded ${file}`);
      console.log("uploaded", filePath);
    }
    await publishLog(`Done`);
    console.log("Done...");
  });
}

init();