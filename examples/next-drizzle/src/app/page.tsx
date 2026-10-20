import { cookies } from "next/headers";
import { Demo } from "../components/Demo";

export default async function Home() {
  const current = (await cookies()).get("demo-user")?.value ?? "you";
  return <Demo current={current} />;
}
