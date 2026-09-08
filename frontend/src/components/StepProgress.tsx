interface Props {
  currentStep: number;
  steps: string[];
}

export default function StepProgress({ currentStep, steps }: Props) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        overflowX: 'auto',
      }}
    >
      {steps.map((label, idx) => {
        const stepNum = idx + 1;
        const isComplete = stepNum < currentStep;
        const isActive = stepNum === currentStep;

        return (
          <div
            key={label}
            style={{
              display: 'flex',
              alignItems: 'center',
              flex: idx < steps.length - 1 ? 1 : undefined,
            }}
          >
            {/* Step item */}
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: '6px',
                minWidth: '80px',
              }}
            >
              {/* Circle */}
              <div
                style={{
                  width: '32px',
                  height: '32px',
                  borderRadius: '50%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '13px',
                  fontWeight: 700,
                  flexShrink: 0,
                  background: isComplete
                    ? 'var(--green)'
                    : isActive
                    ? 'var(--purple)'
                    : 'transparent',
                  border:
                    isComplete || isActive
                      ? 'none'
                      : '2px solid rgba(255, 255, 255, 0.2)',
                  color: isComplete || isActive ? 'white' : 'var(--text-muted)',
                  transition: 'all 0.3s',
                }}
              >
                {isComplete ? (
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                    <path
                      d="M2.5 7l3 3 6-6"
                      stroke="white"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                ) : (
                  stepNum
                )}
              </div>

              {/* Label */}
              <span
                style={{
                  fontSize: '11px',
                  fontWeight: isActive ? 700 : 400,
                  color: isActive
                    ? 'var(--text)'
                    : isComplete
                    ? 'var(--green)'
                    : 'var(--text-muted)',
                  textAlign: 'center',
                  whiteSpace: 'nowrap',
                  transition: 'color 0.3s',
                }}
              >
                {label}
              </span>
            </div>

            {/* Connector line */}
            {idx < steps.length - 1 && (
              <div
                style={{
                  flex: 1,
                  height: '2px',
                  background: isComplete ? 'var(--green)' : 'rgba(255, 255, 255, 0.1)',
                  marginBottom: '22px',
                  transition: 'background 0.3s',
                  minWidth: '20px',
                }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
