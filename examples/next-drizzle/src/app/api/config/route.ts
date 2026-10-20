import { vapid } from "../../../notify";

// The page needs the public half to subscribe; the private half never leaves the server.
export function GET() {
  return Response.json({ vapidPublicKey: vapid.publicKey });
}
