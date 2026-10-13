/** @vitest-environment jsdom */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Callout } from "./callout.js";

afterEach(cleanup);

describe("Callout", () => {
  it("renders success and warning tones without green or yellow classes", () => {
    const { container: success } = render(
      <Callout tone="green">Success message</Callout>
    );
    const successHtml = success.innerHTML;
    
    expect(successHtml.includes("text-green")).toBe(false);
    expect(successHtml.includes("bg-green")).toBe(false);
    expect(successHtml.includes("border-green")).toBe(false);
    
    cleanup();
    
    const { container: warning } = render(
      <Callout tone="yellow">Warning message</Callout>
    );
    const warningHtml = warning.innerHTML;
    
    expect(warningHtml.includes("text-yellow")).toBe(false);
    expect(warningHtml.includes("bg-yellow")).toBe(false);
    expect(warningHtml.includes("border-yellow")).toBe(false);
  });
  
  it("renders red tone with failure color for icon", () => {
    const { container } = render(<Callout tone="red">Error message</Callout>);
    const html = container.innerHTML;
    
    expect(html.includes("text-state-failed")).toBe(true);
  });
  
  it("renders other tones with neutral icon color", () => {
    const { container: blue } = render(<Callout tone="blue">Info message</Callout>);
    expect(blue.innerHTML.includes("text-muted-foreground")).toBe(true);
    
    cleanup();
    
    const { container: purple } = render(<Callout tone="purple">Purple message</Callout>);
    expect(purple.innerHTML.includes("text-muted-foreground")).toBe(true);
  });
});
