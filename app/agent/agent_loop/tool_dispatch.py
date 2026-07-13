"""Parallel tool dispatch with mid-flight interrupt support.

``Agent.run`` schedules every tool call for an iteration as a coroutine
and hands the bundle to :func:`gather_or_cancel`.  If no interrupt
event is supplied (or it never fires) this behaves exactly like
``asyncio.gather(..., return_exceptions=True)``.

When the interrupt fires mid-execution:

1. All still-pending tasks are cancelled.
2. Already-completed tasks keep their real results.
3. Cancelled tasks are reported as cancelled. A task that ignores cancellation
   is explicitly reported as still stopping and remains owned until it exits.
"""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING

from loguru import logger

if TYPE_CHECKING:
    from app.agent.schemas.chat import ToolCall


_CANCELLATION_TIMEOUT = 0.1
_detached_tool_tasks: set[asyncio.Future] = set()


def active_detached_tool_count() -> int:
    """Return the number of cancellation-resistant tool tasks still running."""
    return len(_detached_tool_tasks)


async def gather_or_cancel(
    coros: list,
    interrupt_event: asyncio.Event | None,
    tc_list: list[ToolCall],
    agent_name: str,
) -> list[tuple[ToolCall, str] | BaseException]:
    """Run *coros* in parallel; cancel unfinished ones on interrupt.

    Results preserve the order of *tc_list*.
    """
    if not coros:
        return []

    tasks = [asyncio.ensure_future(c) for c in coros]

    if interrupt_event is None:
        # No interrupt possible — plain gather behaviour
        return await asyncio.gather(*tasks, return_exceptions=True)

    # Create a waiter that fires when the interrupt event is set
    interrupt_waiter = asyncio.ensure_future(interrupt_event.wait())

    try:
        # Wait until either all tool tasks finish or the interrupt fires
        tool_set = set(tasks)
        done: set[asyncio.Future] = set()
        pending = tool_set.copy()

        while pending:
            # Wait for the first completed item among pending tools + interrupt
            wait_set = pending | {interrupt_waiter}
            newly_done, _ = await asyncio.wait(
                wait_set, return_when=asyncio.FIRST_COMPLETED
            )
            done |= newly_done & tool_set
            pending = tool_set - done

            if interrupt_waiter in newly_done:
                # Interrupt fired — cancel remaining tool tasks
                for t in pending:
                    t.cancel()
                # Do not let a tool that swallows cancellation block the agent.
                if pending:
                    _, still_pending = await asyncio.wait(
                        pending, timeout=_CANCELLATION_TIMEOUT
                    )
                    for task in still_pending:
                        _detached_tool_tasks.add(task)
                        task.add_done_callback(_finish_detached_tool_task)
                    if still_pending:
                        logger.warning(
                            "tool_cancellation_timeout agent={} pending_tools={}",
                            agent_name,
                            len(still_pending),
                        )
                break
    except asyncio.CancelledError:
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        raise
    finally:
        interrupt_waiter.cancel()
        # Suppress the CancelledError from the waiter
        try:
            await interrupt_waiter
        except (asyncio.CancelledError, Exception):
            pass

    # Build results — preserve order matching tc_list
    results: list[tuple[ToolCall, str] | BaseException] = []
    for task, tc in zip(tasks, tc_list):
        if not task.done():
            results.append((tc, "Cancellation requested; tool is still stopping."))
            logger.warning(
                "tool_cancellation_pending agent={} tool={}",
                agent_name,
                tc.function.name,
            )
        elif task.cancelled():
            results.append((tc, "Cancelled by user."))
            logger.info(
                "tool_cancelled agent={} tool={}",
                agent_name,
                tc.function.name,
            )
        elif task.exception() is not None:
            results.append(task.exception())  # type: ignore[arg-type]
        else:
            results.append(task.result())
    return results


def _finish_detached_tool_task(task: asyncio.Future) -> None:
    """Release an owned cancellation-resistant task and observe its failure."""
    _detached_tool_tasks.discard(task)
    try:
        task.exception()
    except asyncio.CancelledError:
        pass
