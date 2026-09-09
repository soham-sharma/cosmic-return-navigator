'use client';

import { useEffect, useState } from 'react';
import { PROCESSING_STEPS } from '@/lib/mock-data';
import type { ProcessingStep } from '@/lib/types';

export default function ProcessingScreen() {
  const [steps, setSteps] = useState<ProcessingStep[]>(
    PROCESSING_STEPS.map((s) => ({ ...s, done: false }))
  );
  const [currentIdx, setCurrentIdx] = useState(0);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    const STEP_DURATION_MS = 1600;
    const TOTAL_MS = 9500;
    const stepCount = PROCESSING_STEPS.length;

    let stepIdx = 0;

    // Advance one step every STEP_DURATION_MS
    const stepTimer = setInterval(() => {
      stepIdx += 1;
      if (stepIdx <= stepCount) {
        const capturedIdx = stepIdx;
        setSteps((prev) =>
          prev.map((s, i) => (i < capturedIdx - 1 ? { ...s, done: true } : s))
        );
        setCurrentIdx(capturedIdx - 1);
      } else {
        clearInterval(stepTimer);
        setSteps((prev) => prev.map((s) => ({ ...s, done: true })));
        setProgress(100);
      }
    }, STEP_DURATION_MS);

    // Smooth progress bar over total duration (caps at 98 so it doesn't jump to 100 early)
    const progressTick = Math.floor(TOTAL_MS / 98);
    const progressTimer = setInterval(() => {
      setProgress((p) => {
        if (p >= 98) {
          clearInterval(progressTimer);
          return p;
        }
        return p + 1;
      });
    }, progressTick);

    return () => {
      clearInterval(stepTimer);
      clearInterval(progressTimer);
    };
  }, []);

  return (
    <div
      style={{
        maxWidth: '480px',
        margin: '0 auto',
        padding: '20px 0',
      }}
    >
      <div className="card" style={{ padding: '40px 36px' }}>
        <h2
          className="gradient-text"
          style={{
            fontSize: '22px',
            fontWeight: 700,
            textAlign: 'center',
            marginBottom: '8px',
          }}
        >
          Processing your return
        </h2>
        <p
          style={{
            textAlign: 'center',
            color: 'var(--text-muted)',
            fontSize: '14px',
            marginBottom: '36px',
            lineHeight: 1.5,
          }}
        >
          Our AI is reviewing your case. This takes about 30 seconds.
        </p>

        {/* Step list */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '20px',
            marginBottom: '32px',
          }}
        >
          {steps.map((step, idx) => {
            const isCurrent = idx === currentIdx && !step.done;
            const isDone = step.done;

            return (
              <div
                key={step.id}
                style={{ display: 'flex', alignItems: 'flex-start', gap: '14px' }}
              >
                {/* Status icon */}
                <div
                  className={isCurrent ? 'step-active' : ''}
                  style={{
                    width: '28px',
                    height: '28px',
                    borderRadius: '50%',
                    flexShrink: 0,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: isDone
                      ? 'rgba(16, 185, 129, 0.15)'
                      : isCurrent
                      ? 'rgba(124, 58, 237, 0.15)'
                      : 'rgba(255, 255, 255, 0.04)',
                    border: `2px solid ${
                      isDone
                        ? 'var(--green)'
                        : isCurrent
                        ? 'var(--purple)'
                        : 'rgba(255, 255, 255, 0.1)'
                    }`,
                    transition: 'all 0.3s',
                  }}
                >
                  {isDone ? (
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 14 14"
                      fill="none"
                      aria-hidden="true"
                    >
                      <path
                        d="M2.5 7l3 3 6-6"
                        stroke="#10b981"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  ) : isCurrent ? (
                    <div
                      className="spinner"
                      style={{
                        width: '12px',
                        height: '12px',
                        border: '2px solid rgba(124, 58, 237, 0.3)',
                        borderTopColor: 'var(--purple)',
                        borderRadius: '50%',
                      }}
                    />
                  ) : (
                    <div
                      style={{
                        width: '6px',
                        height: '6px',
                        borderRadius: '50%',
                        background: 'rgba(255, 255, 255, 0.2)',
                      }}
                    />
                  )}
                </div>

                {/* Text */}
                <div>
                  <div
                    style={{
                      fontSize: '14px',
                      fontWeight: isCurrent || isDone ? 600 : 400,
                      color: isDone
                        ? 'var(--green)'
                        : isCurrent
                        ? 'var(--text)'
                        : 'var(--text-muted)',
                      marginBottom: '2px',
                      transition: 'color 0.3s',
                    }}
                  >
                    {step.label}
                  </div>
                  <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                    {step.detail}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Progress bar */}
        <div
          style={{
            height: '4px',
            background: 'rgba(124, 58, 237, 0.15)',
            borderRadius: '2px',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              height: '100%',
              width: `${progress}%`,
              background: 'linear-gradient(90deg, var(--purple), var(--purple-light))',
              borderRadius: '2px',
              transition: 'width 0.4s ease',
            }}
          />
        </div>
      </div>
    </div>
  );
}
