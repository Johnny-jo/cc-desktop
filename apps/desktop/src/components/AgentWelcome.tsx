import React, { useRef } from "react";
import { useAgentMascot } from "../hooks/useAgentMascot";
import { AgentEyes } from "./AgentEyes";
import { GalaxyLetter } from "./GalaxyLetter";
import "./AgentWelcome.css";

/** A playful wordmark confined to the new-chat screen. */
export function AgentWelcome({ english = false, galaxyEffectsEnabled = true }: { english?: boolean; galaxyEffectsEnabled?: boolean }) {
  const mark = useRef<HTMLButtonElement>(null);
  const expression = useAgentMascot(mark);
  const play = () => {
    const button = mark.current;
    if (!button || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    button.querySelectorAll<HTMLElement>(".agent-letter, .agent-orbit").forEach((letter, i) => {
      if (letter.matches('.galaxy-letter[data-galaxy-active="true"]')) return;
      letter.getAnimations().forEach((animation) => animation.cancel());
      letter.animate([
        { transform: "translateY(0) rotate(0deg)" },
        { transform: `translateY(-12px) rotate(${i % 2 ? 7 : -7}deg)`, offset: 0.4 },
        { transform: "translateY(0) rotate(0deg)" },
      ], { duration: 460, delay: i * 45, easing: "ease-in-out" });
    });
    button.querySelectorAll<HTMLElement>(".agent-spark").forEach((spark, i) => {
      spark.getAnimations().forEach((animation) => animation.cancel());
      spark.animate([{ opacity: 0, transform: "scale(0.4) rotate(0)" }, { opacity: 1, offset: 0.35 }, { opacity: 0, transform: "scale(1.7) rotate(80deg)" }], { duration: 700, delay: i * 60 });
    });
  };
  return <div className="agent-welcome">
    <button ref={mark} type="button" className="agent-wordmark" data-expression={expression} aria-label="Agent OS" title={english ? "Say hello to your agent" : "点一下，和 Agent 打个招呼"}
      onClick={play}>
      <span className="agent-word" aria-hidden="true">{"Agent".split("").map((letter, i) => <span className="agent-letter" key={i}>{letter}</span>)}</span>
      <span className="agent-os" aria-hidden="true">
        <span className="agent-orbit">
          <span className="agent-orbit-body">
            <svg className="agent-slime-art" viewBox="0 0 100 100" fill="none" aria-hidden="true" focusable="false">
              <circle className="agent-slime-outline" cx="50" cy="46" r="36" fill="#111c22" />
            </svg>
            <span className="agent-slime-face">
              <span className="agent-eyes"><AgentEyes expression={expression} /></span>
            </span>
          </span>
        </span>
        <GalaxyLetter enabled={galaxyEffectsEnabled} />
      </span>
      <span className="agent-spark spark-one" aria-hidden="true">✦</span><span className="agent-spark spark-two" aria-hidden="true">✧</span><span className="agent-spark spark-three" aria-hidden="true">✦</span>
    </button>
    <p className="agent-welcome-caption">{english ? "A little idea. A new possibility." : "一个想法，一种新可能。"}</p>
  </div>;
}
