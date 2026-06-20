"use client";
/*
 * Documentation:
 * Skeleton Text — https://app.subframe.com/7dd45c05240f/library?component=Skeleton+Text_a9aae3f0-955e-4607-a272-374f1dc18f4b
 */

import React from "react";
import * as SubframeCore from "@subframe/core";
import * as SubframeUtils from "../../utils";

export interface SkeletonTextRootProps
  extends React.ComponentProps<typeof SubframeCore.Skeleton> {
  size?: "default" | "label" | "subheader" | "section-header" | "header";
  className?: string;
}

const SkeletonTextRoot = React.forwardRef<
  React.ElementRef<typeof SubframeCore.Skeleton>,
  SkeletonTextRootProps
>(function SkeletonTextRoot(
  { size = "default", className, ...otherProps }: SkeletonTextRootProps,
  ref
) {
  return (
    <SubframeCore.Skeleton
      className={SubframeUtils.twClassNames(
        "group/a9aae3f0 flex h-5 w-full flex-col items-start gap-2 rounded-md bg-neutral-200",
        {
          "h-10": size === "header",
          "h-9": size === "section-header",
          "h-7": size === "subheader",
          "h-4": size === "label",
        },
        className
      )}
      ref={ref}
      {...otherProps}
    />
  );
});

export const SkeletonText = SkeletonTextRoot;
