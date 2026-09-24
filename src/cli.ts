const [command = "start"] = process.argv.slice(2);
const commands = ["start", "status", "report", "stop", "cancel-all", "reset-stop"];
if (!commands.includes(command)) { console.error(`Usage: bun run trader ${commands.join("|")}`); process.exit(2); }
if (command === "start") {
  await import("./index");
} else {
  const token = await Bun.file(`${process.env.DATA_DIR ?? "data"}/admin.token`).text().catch(() => "");
  if (!token.trim()) { console.error("No running paper daemon token found. Start the daemon first."); process.exit(1); }
  const port = Number(process.env.ADMIN_PORT ?? "3001");
  const path = command === "status" || command === "report" ? `/${command}` : `/admin/${command}`;
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: command === "status" || command === "report" ? "GET" : "POST", headers: { authorization: `Bearer ${token.trim()}` } });
    const body = await response.json();
    if (!response.ok) throw new Error(JSON.stringify(body));
    console.log(JSON.stringify(body, null, 2));
  } catch (error) { console.error(`Daemon control failed: ${(error as Error).message}`); process.exit(1); }
}
