import asyncio
import json
import sys
import httpx

BASE = "http://localhost:8000/api"
SESSION_ID = "019f17b4-fb60-7452-afdd-53795bcee678"
PROMPT = (
    "Please recreate the demo files under demo_files/:\n"
    "1. Python: demo_files/python/syntax_error.py (e.g., def foo()\n"
    "2. TypeScript: demo_files/typescript/syntax_error.ts (e.g., missing closing brace)\n"
    "3. Rust: demo_files/rust/syntax_error.rs (e.g., println!(\"Hello\" ;) and demo_files/rust/Cargo.toml with [[bin]] sections for the rust files.\n"
    "Please use the write tool to write all of them so the LSP diagnostics run."
)

async def stream_session(session_id: str):
    async with httpx.AsyncClient() as client:
        # First post the message
        print("Posting message...")
        r = await client.post(f"{BASE}/team/chat", data={
            "message": PROMPT,
            "session_id": session_id
        }, timeout=30)
        r.raise_for_status()
        print("Message posted. Status:", r.status_code)

        # Stream the SSE events
        print("Streaming events...")
        async with client.stream("GET", f"{BASE}/team/{session_id}/stream", timeout=120) as response:
            async for line in response.aiter_lines():
                if line.startswith("data:"):
                    raw = line[5:].strip()
                    try:
                        data = json.loads(raw)
                        if "choices" in data:
                            delta = data["choices"][0].get("delta", {})
                            if "content" in delta and delta["content"]:
                                print(delta["content"], end="", flush=True)
                            elif "tool_calls" in delta:
                                print(f"\n[Tool Call]: {delta['tool_calls']}")
                        elif "event" in data:
                            ev = data["event"]
                            print(f"\n[Event]: {ev}")
                            if ev == "done":
                                break
                    except Exception:
                        pass

async def main():
    await stream_session(SESSION_ID)

if __name__ == "__main__":
    asyncio.run(main())
