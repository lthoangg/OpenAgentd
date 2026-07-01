import asyncio
import json
import httpx

from manual._common import DEFAULT_BASE
BASE = DEFAULT_BASE
SESSION_ID = "019f17b4-fb60-7452-afdd-53795bcee678"
PROMPT = (
    "Please touch the files `demo_files/typescript/syntax_error.ts` and `demo_files/rust/syntax_error.rs` "
    "(e.g., add a comment at the top of each) using the write or edit tool, so that we can verify the LSP "
    "diagnostics are now detected and returned for both."
)

def post_message(base: str, message: str, session_id: str) -> dict:
    data = {"message": message, "session_id": session_id}
    response = httpx.post(f"{base}/team/chat", data=data, timeout=30)
    response.raise_for_status()
    return response.json()

async def stream_until_done(base: str, session_id: str):
    print(f"Streaming session {session_id} until done...")
    async with httpx.AsyncClient() as client:
        async with client.stream("GET", f"{base}/team/{session_id}/stream", timeout=180) as response:
            async for line in response.aiter_lines():
                if line.startswith("data:"):
                    raw = line[5:].strip()
                    try:
                        data = json.loads(raw)
                        # Print assistant response chunks or tool calls
                        if "choices" in data:
                            delta = data["choices"][0].get("delta", {})
                            if "content" in delta and delta["content"]:
                                print(delta["content"], end="", flush=True)
                            elif "tool_calls" in delta:
                                print(f"\n[Tool Call]: {delta['tool_calls']}")
                        elif "event" in data:
                            print(f"\n[Event]: {data['event']}")
                    except Exception:
                        pass
                elif line.strip() == "":
                    pass

async def main():
    print(f"Posting prompt to session {SESSION_ID}...")
    post_message(BASE, PROMPT, SESSION_ID)
    await stream_until_done(BASE, SESSION_ID)
    print("\nDone!")

if __name__ == "__main__":
    asyncio.run(main())
