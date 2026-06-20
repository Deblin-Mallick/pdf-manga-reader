"use client";
/*
 * Documentation:
 * Progress — https://app.subframe.com/7dd45c05240f/library?component=Progress_60964db0-a1bf-428b-b9d5-f34cdf58ea77
 */

import React from "react";
import * as SubframeCore from "@subframe/core";
import * as SubframeUtils from "../../utils";

export interface IndicatorProps
  extends React.ComponentProps<typeof SubframeCore.Progress.Indicator> {
  className?: string;
}

const Indicator = React.forwardRef<HTMLDivElement, IndicatorProps>(
  function Indicator({ className, ...otherProps }: IndicatorProps, ref) {
    return (
      <SubframeCore.Progress.Indicator asChild={true} {...otherProps}>
        <div
          className={SubframeUtils.twClassNames(
            "flex h-2 w-full flex-col items-start gap-2 rounded-full",
            className
          )}
          style={{ background: 'linear-gradient(90deg, #7c3aed, #8b5cf6, #6366f1)' }}
          ref={ref}
        />
      </SubframeCore.Progress.Indicator>
    );
  }
);

export interface ProgressRootProps
  extends React.ComponentProps<typeof SubframeCore.Progress.Root> {
  value?: number;
  className?: string;
}

const ProgressRoot = React.forwardRef<HTMLDivElement, ProgressRootProps>(
  function ProgressRoot(
    { value = 30, className, ...otherProps }: ProgressRootProps,
    ref
  ) {
    return (
      <SubframeCore.Progress.Root asChild={true} value={value} {...otherProps}>
        <div
          className={SubframeUtils.twClassNames(
            "flex h-2 w-full flex-col items-start gap-2 overflow-hidden rounded-full",
            className
          )}
          style={{ backgroundColor: 'rgba(255,255,255,0.08)' }}
          ref={ref}
        >
          <Indicator />
        </div>
      </SubframeCore.Progress.Root>
    );
  }
);

export const Progress = Object.assign(ProgressRoot, {
  Indicator,
});
