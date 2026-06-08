package main

import (
	"context"
	"fmt"
	"os"

	"mini-godbolt/internal/app"
)

func main() {
	if err := app.Run(context.Background(), os.Args[1:]); err != nil {
		fmt.Fprintf(os.Stderr, "mini-godbolt: %v\n", err)
		os.Exit(1)
	}
}
