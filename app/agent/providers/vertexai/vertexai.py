from typing import Any

from pydantic.types import SecretStr

from app.agent.providers.googlegenai.googlegenai import GeminiProviderBase

# Vertex GenerateContent REST API:
# https://cloud.google.com/vertex-ai/generative-ai/docs/reference/rest/v1/projects.locations.publishers.models/generateContent
# Express mode — no project/location, API key only
VERTEX_EXPRESS_BASE_URL = "https://aiplatform.googleapis.com/v1"
# Normal mode — regional endpoint
VERTEX_NORMAL_BASE_URL = "https://{location}-aiplatform.googleapis.com/v1"
# Normal mode — global location uses the same host as express (no location prefix)
VERTEX_GLOBAL_BASE_URL = "https://aiplatform.googleapis.com/v1"


class VertexAIProvider(GeminiProviderBase):
    """
    Vertex AI provider supporting both express and normal modes.

    Express mode (default — no project/location):
      URL: aiplatform.googleapis.com/v1/publishers/google/models/{model}
      Auth: x-goog-api-key with a Google Cloud API key
      Get key: https://console.cloud.google.com/expressmode

    Normal mode (project + location set):
      URL: {location}-aiplatform.googleapis.com/v1/projects/{project}/locations/{location}/publishers/google/models/{model}
      Auth: x-goog-api-key with same Google Cloud API key
      Requires the model to be enabled in your GCP project.
    """

    def __init__(
        self,
        api_key: str | SecretStr,
        model: str,
        project: str | None = None,
        location: str = "global",
        max_tokens: int | None = None,
        model_kwargs: dict[str, Any] | None = None,
    ):
        super().__init__(
            max_tokens=max_tokens,
            model_kwargs=model_kwargs,
        )

        resolved_key = (
            api_key.get_secret_value() if isinstance(api_key, SecretStr) else api_key
        )
        if not resolved_key:
            raise ValueError(
                "Vertex AI API key is required. Provide it or set VERTEXAI_API_KEY."
            )

        self.api_key = resolved_key
        self.model = model
        self.project = project
        self.location = location

        if project:
            # global location uses the same host as express (no location prefix)
            if location == "global":
                self.base_url = VERTEX_GLOBAL_BASE_URL
            else:
                self.base_url = VERTEX_NORMAL_BASE_URL.format(location=location)
        else:
            self.base_url = VERTEX_EXPRESS_BASE_URL

    def _auth_headers(self) -> dict[str, str]:
        return {"x-goog-api-key": self.api_key}

    def _build_url(self, method: str) -> str:
        if self.project:
            # Normal mode: project-scoped path
            base = (
                f"{self.base_url}/projects/{self.project}"
                f"/locations/{self.location}"
                f"/publishers/google/models/{self.model}"
            )
        else:
            # Express mode: no project in path
            base = f"{self.base_url}/publishers/google/models/{self.model}"
        return f"{base}:{method}"
