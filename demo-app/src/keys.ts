import { generateVapidKeys } from "easy-ping/providers/web-push";

const keys = await generateVapidKeys();

console.log("\nAdd these to demo-app/.env:\n");
console.log(`VAPID_PUBLIC_KEY=${keys.publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${keys.privateKey}\n`);
