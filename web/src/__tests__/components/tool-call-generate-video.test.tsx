import { describe, it, expect, afterEach } from "bun:test";
import "@testing-library/jest-dom";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToolCall } from "@/components/ToolCall";

afterEach(() => cleanup());

describe("ToolCall generate_video display", () => {
  it("shows the tool name in mono and the filename as a plain target when filename is provided", () => {
    const args = JSON.stringify({
      prompt: "Create a video of a spinning cube",
      filename: "cube_spin",
    });
    render(<ToolCall name="generate_video" args={args} done={true} />);

    // The row is the real tool name, then the sanitised filename
    expect(screen.getByText("generate_video").className).toContain("font-mono");
    expect(screen.getByText("cube_spin.mp4")).toBeInTheDocument();
    expect(screen.queryByText(/Filming/i)).toBeNull();
    expect(screen.queryByText(/Generate Video/)).toBeNull();
    expect(document.querySelector('[title="generate_video: cube_spin.mp4"]')).not.toBeNull();
  });

  it("shows only the tool name when filename is not provided", () => {
    const args = JSON.stringify({
      prompt: "Create a video",
    });
    render(<ToolCall name="generate_video" args={args} done={true} />);

    expect(screen.getByText("generate_video")).toBeInTheDocument();
    expect(screen.queryByText(/Filming/i)).toBeNull();
    // No target: the row title is just the tool name
    expect(document.querySelector('[title="generate_video"]')).not.toBeNull();
  });

  it("sanitizes filename by removing extension and adding .mp4", () => {
    const args = JSON.stringify({
      prompt: "Create a video",
      filename: "my_video.avi",
    });
    render(<ToolCall name="generate_video" args={args} done={true} />);

    // Should show "my_video.mp4" not "my_video.avi"
    expect(screen.getByText(/my_video\.mp4/i)).toBeInTheDocument();
  });

  it("displays first_frame input when present", async () => {
    const user = userEvent.setup();
    const args = JSON.stringify({
      prompt: "Create a video",
      filename: "video",
      first_frame: "frame1.png",
    });
    render(<ToolCall name="generate_video" args={args} done={true} />);

    // Expand to see args
    const button = screen.getByRole("button");
    await user.click(button);

    expect(screen.getByText(/first_frame/i)).toBeInTheDocument();
    expect(screen.getByText(/frame1\.png/i)).toBeInTheDocument();
  });

  it("displays last_frame input when present", async () => {
    const user = userEvent.setup();
    const args = JSON.stringify({
      prompt: "Create a video",
      filename: "video",
      last_frame: "final_frame.png",
    });
    render(<ToolCall name="generate_video" args={args} done={true} />);

    const button = screen.getByRole("button");
    await user.click(button);

    expect(screen.getByText(/last_frame/i)).toBeInTheDocument();
    expect(screen.getByText(/final_frame\.png/i)).toBeInTheDocument();
  });

  it("displays reference_images input when present", async () => {
    const user = userEvent.setup();
    const args = JSON.stringify({
      prompt: "Create a video",
      filename: "video",
      reference_images: ["ref1.png", "ref2.png"],
    });
    render(<ToolCall name="generate_video" args={args} done={true} />);

    const button = screen.getByRole("button");
    await user.click(button);

    expect(screen.getByText(/references/i)).toBeInTheDocument();
    expect(screen.getByText(/ref1\.png/i)).toBeInTheDocument();
  });

  it("displays all inputs together", async () => {
    const user = userEvent.setup();
    const args = JSON.stringify({
      prompt: "Create a smooth animation",
      filename: "animation",
      first_frame: "start.png",
      last_frame: "end.png",
      reference_images: ["style.png"],
    });
    render(<ToolCall name="generate_video" args={args} done={true} />);

    const button = screen.getByRole("button");
    await user.click(button);

    expect(screen.getByText(/first_frame/i)).toBeInTheDocument();
    expect(screen.getByText(/last_frame/i)).toBeInTheDocument();
    expect(screen.getByText(/references/i)).toBeInTheDocument();
    expect(screen.getByText(/Create a smooth animation/i)).toBeInTheDocument();
  });

  it("suppresses result display (suppressResult: true)", async () => {
    const user = userEvent.setup();
    const args = JSON.stringify({
      prompt: "Create a video",
      filename: "video",
    });
    const result = "![video](output/video.mp4)";

    render(
      <ToolCall
        name="generate_video"
        args={args}
        done={true}
        result={result}
      />,
    );

    // Expand to see details
    const button = screen.getByRole("button");
    await user.click(button);

    // Result section should NOT be present (suppressResult: true)
    expect(screen.queryByText(/^result$/i)).toBeNull();
    // The markdown result should not appear
    expect(screen.queryByText(/output\/video\.mp4/i)).toBeNull();
  });

  it("renders without crashing when pending (no args, no done)", () => {
    render(<ToolCall name="generate_video" />);

    // When no args, shows the real tool name instead of a custom header.
    expect(screen.getByText("generate_video")).toBeInTheDocument();
    expect(screen.queryByText(/Generate Video/)).toBeNull();
    expect(screen.queryByText(/pending/i)).toBeNull();
  });

  it("renders without crashing when running (args, no done)", () => {
    const args = JSON.stringify({
      prompt: "Create a video",
      filename: "video",
    });
    render(<ToolCall name="generate_video" args={args} />);

    expect(screen.getByText("generate_video")).toBeInTheDocument();
    expect(screen.getByText("video.mp4")).toBeInTheDocument();
    expect(screen.queryByText(/Filming/i)).toBeNull();
    // Should not show "pending" when args are present
    expect(screen.queryByText(/pending/i)).toBeNull();
  });

  it("shows no pulse, running dot or 'running…' when done=true", () => {
    const args = JSON.stringify({
      prompt: "Create a video",
      filename: "video",
    });
    render(<ToolCall name="generate_video" args={args} done={true} />);

    const btn = screen.getByRole("button");
    expect(btn.querySelector(".animate-pulse")).toBeNull();
    expect(btn.querySelector("[data-running-dot]")).toBeNull();
    expect(btn.textContent).not.toContain("running…");
  });

  it("shows 'running…' when done=false, with no dot or pulse", () => {
    const args = JSON.stringify({
      prompt: "Create a video",
      filename: "video",
    });
    render(<ToolCall name="generate_video" args={args} done={false} />);

    const btn = screen.getByRole("button");
    expect(btn.querySelector("[data-running-dot]")).toBeNull();
    expect(btn.querySelector(".animate-pulse")).toBeNull();
    expect(btn.textContent).toContain("video.mp4");
    expect(btn.textContent).toContain("running…");
  });

  it("handles absent first_frame gracefully", async () => {
    const user = userEvent.setup();
    const args = JSON.stringify({
      prompt: "Create a video",
      filename: "video",
    });
    render(<ToolCall name="generate_video" args={args} done={true} />);

    const button = screen.getByRole("button");
    await user.click(button);

    // Should not show "first_frame:" line if not provided
    expect(screen.queryByText(/first_frame:/)).toBeNull();
  });

  it("handles empty reference_images array gracefully", async () => {
    const user = userEvent.setup();
    const args = JSON.stringify({
      prompt: "Create a video",
      filename: "video",
      reference_images: [],
    });
    render(<ToolCall name="generate_video" args={args} done={true} />);

    const button = screen.getByRole("button");
    await user.click(button);

    // Should not show "references:" line if array is empty
    expect(screen.queryByText(/references:/)).toBeNull();
  });

  it("handles missing optional fields", async () => {
    const user = userEvent.setup();
    const args = JSON.stringify({
      prompt: "Create a video",
      filename: "video",
    });
    render(<ToolCall name="generate_video" args={args} done={true} />);

    const button = screen.getByRole("button");
    await user.click(button);

    // Should only show prompt, no first_frame/last_frame/references
    expect(screen.getByText(/Create a video/i)).toBeInTheDocument();
    expect(screen.queryByText(/first_frame/i)).toBeNull();
    expect(screen.queryByText(/last_frame/i)).toBeNull();
    expect(screen.queryByText(/references/i)).toBeNull();
  });

  it("displays filename with special characters correctly", () => {
    const args = JSON.stringify({
      prompt: "Create a video",
      filename: "my-video_v2",
    });
    render(<ToolCall name="generate_video" args={args} done={true} />);

    expect(screen.getByText(/my-video_v2\.mp4/i)).toBeInTheDocument();
  });

  it("is expandable when it has args", async () => {
    const user = userEvent.setup();
    const args = JSON.stringify({
      prompt: "Create a video",
      filename: "video",
    });
    render(<ToolCall name="generate_video" args={args} done={true} />);

    const button = screen.getByRole("button");
    expect(button).toHaveAttribute("aria-expanded", "false");

    await user.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
  });

  it("button is clickable when expandable", async () => {
    const user = userEvent.setup();
    const args = JSON.stringify({
      prompt: "Create a video",
      filename: "video",
    });
    render(<ToolCall name="generate_video" args={args} done={true} />);

    const button = screen.getByRole("button");
    // Button should be clickable (not disabled)
    expect(button).not.toHaveAttribute("disabled");

    // Should be able to click to expand
    await user.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
  });
});
