"""Regression tests for multimodal message-parts serialization across providers.

Focus:
- HumanMessage.parts must survive provider conversion (text + image cases)
- ToolMessage.parts must survive provider conversion where the provider supports
  multimodal tool-result content

These tests are intentionally concise and target the real conversion entrypoints
that each provider path uses.
"""

from __future__ import annotations

import base64

from app.agent.providers.anthropic.anthropic import _split_messages
from app.agent.providers.bedrock.bedrock import _messages_to_bedrock
from app.agent.providers.deepseek.deepseek import _DeepSeekCompletionsHandler
from app.agent.providers.googlegenai.googlegenai import GoogleGenAIProvider
from app.agent.providers.openai.completions import CompletionsHandler
from app.agent.providers.openai.responses import ResponsesHandler
from app.agent.schemas.chat import HumanMessage, ImageDataBlock, TextBlock, ToolMessage


def _img_b64() -> str:
    return base64.b64encode(b"fake_image_data").decode("ascii")


def test_anthropic_human_message_parts_text_and_image() -> None:
    msg = HumanMessage(
        content="ignored",
        parts=[
            TextBlock(
                text="[Attached image path: ./uploads/example.png. Use the read tool to inspect it.]"
            ),
            ImageDataBlock(data=_img_b64(), media_type="image/png"),
        ],
    )

    _, out = _split_messages([msg])

    assert out[0]["role"] == "user"
    assert out[0]["content"][0] == {
        "type": "text",
        "text": "[Attached image path: ./uploads/example.png. Use the read tool to inspect it.]",
    }
    assert out[0]["content"][1]["type"] == "image"
    assert out[0]["content"][1]["source"]["type"] == "base64"
    assert out[0]["content"][1]["source"]["media_type"] == "image/png"


def test_anthropic_tool_message_parts_text_and_image() -> None:
    msg = ToolMessage(
        tool_call_id="tool-1",
        name="read",
        content="[Image: ./uploads/example.png]",
        parts=[
            TextBlock(text="[Image: ./uploads/example.png]"),
            ImageDataBlock(data=_img_b64(), media_type="image/png"),
        ],
    )

    _, out = _split_messages([msg])

    assert out[0]["role"] == "user"
    block = out[0]["content"][0]
    assert block["type"] == "tool_result"
    assert isinstance(block["content"], list)
    assert block["content"][0]["type"] == "text"
    assert block["content"][1]["type"] == "image"
    assert block["content"][1]["source"]["type"] == "base64"


def test_openai_completions_human_message_parts_text_and_image() -> None:
    handler = CompletionsHandler(
        model="gpt-4o",
        base_url="https://api.openai.com/v1",
        headers={"Authorization": "Bearer sk-test"},
    )
    msg = HumanMessage(
        parts=[
            TextBlock(text="describe it"),
            ImageDataBlock(data=_img_b64(), media_type="image/png"),
        ]
    )

    converted = handler.convert_messages([msg])[0].model_dump(exclude_none=True)

    assert converted["role"] == "user"
    assert converted["content"][0]["type"] == "text"
    assert converted["content"][1]["type"] == "image_url"
    assert converted["content"][1]["image_url"]["url"].startswith(
        "data:image/png;base64,"
    )


def test_openai_responses_human_message_parts_text_and_image() -> None:
    handler = ResponsesHandler(
        model="gpt-5",
        base_url="https://api.openai.com/v1",
        headers={"Authorization": "Bearer sk-test"},
    )
    msg = HumanMessage(
        parts=[
            TextBlock(text="describe it"),
            ImageDataBlock(data=_img_b64(), media_type="image/png"),
        ]
    )

    converted = handler.convert_messages([msg])[0]

    assert converted["role"] == "user"
    assert converted["content"][0]["type"] == "input_text"
    assert converted["content"][1]["type"] == "input_image"
    assert converted["content"][1]["image_url"].startswith("data:image/png;base64,")


def test_deepseek_human_message_parts_text_and_image() -> None:
    handler = _DeepSeekCompletionsHandler(
        model="deepseek-v4-flash",
        base_url="https://api.deepseek.com",
        headers={"Authorization": "Bearer ds-test"},
    )
    msg = HumanMessage(
        parts=[
            TextBlock(text="describe it"),
            ImageDataBlock(data=_img_b64(), media_type="image/png"),
        ]
    )

    converted = handler.convert_messages([msg])[0]

    assert converted.role == "user"
    assert converted.content[0]["type"] == "text"
    assert converted.content[1]["type"] == "image_url"
    assert converted.content[1]["image_url"]["url"].startswith("data:image/png;base64,")


def test_bedrock_human_message_parts_text_and_image() -> None:
    msg = HumanMessage(
        parts=[
            TextBlock(text="describe it"),
            ImageDataBlock(data=_img_b64(), media_type="image/png"),
        ]
    )

    _, converted = _messages_to_bedrock([msg])

    assert converted[0]["role"] == "user"
    assert converted[0]["content"][0] == {"text": "describe it"}
    assert converted[0]["content"][1]["image"]["format"] == "png"


def test_bedrock_tool_message_parts_text_and_image() -> None:
    msg = ToolMessage(
        tool_call_id="tool-1",
        name="read",
        content="[Image: ./uploads/example.png]",
        parts=[
            TextBlock(text="[Image: ./uploads/example.png]"),
            ImageDataBlock(data=_img_b64(), media_type="image/png"),
        ],
    )

    _, converted = _messages_to_bedrock([msg])

    assert converted[0]["role"] == "user"
    result = converted[0]["content"][0]["toolResult"]
    assert result["toolUseId"] == "tool-1"
    assert result["content"][0] == {"text": "[Image: ./uploads/example.png]"}
    assert result["content"][1]["image"]["format"] == "png"


def test_googlegenai_human_message_parts_text_and_image() -> None:
    provider = GoogleGenAIProvider(api_key="test-key", model="gemini-3.1-flash")
    msg = HumanMessage(
        parts=[
            TextBlock(text="describe it"),
            ImageDataBlock(data=_img_b64(), media_type="image/png"),
        ]
    )

    contents, _ = provider._convert_messages_to_gemini([msg])

    assert contents[0].parts[0].text == "describe it"
    assert contents[0].parts[1].inline_data.mime_type == "image/png"


def test_googlegenai_tool_message_parts_text_and_image() -> None:
    provider = GoogleGenAIProvider(api_key="test-key", model="gemini-3.1-flash")
    msg = ToolMessage(
        tool_call_id="tool-1",
        name="read",
        content="[Image: ./uploads/example.png]",
        parts=[
            TextBlock(text="[Image: ./uploads/example.png]"),
            ImageDataBlock(data=_img_b64(), media_type="image/png"),
        ],
    )

    contents, _ = provider._convert_messages_to_gemini([msg])

    assert contents[0].parts[0].function_response is not None
    assert contents[0].parts[1].text == "[Image: ./uploads/example.png]"
    assert contents[0].parts[2].inline_data.mime_type == "image/png"
