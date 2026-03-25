.PHONY: setup install run dev build check lint clean help

setup:
	@echo "Checking Rust..."
	@which rustc >/dev/null 2>&1 || (echo "Error: Rust is not installed." && exit 1)
	@echo "Checking Node.js..."
	@which node >/dev/null 2>&1 || (echo "Error: Node.js not found. Install Node.js 22+ first." && exit 1)
	npm install
	@echo ""
	@echo "Setup complete. Run 'make run' to start."

install:
	npm install

run: dev

dev: install
	npx tauri dev

build: install
	npx tauri build

check:
	npx tsc --noEmit
	cd src-tauri && cargo check

lint:
	npx eslint src/

clean:
	rm -rf dist/
	rm -rf src-tauri/target/
	rm -rf node_modules/.vite/

help:
	@echo "Available commands:"
	@echo "  make setup   Check env and install deps"
	@echo "  make run     Start app in dev mode"
	@echo "  make dev     Start app in dev mode"
	@echo "  make build   Build production app"
	@echo "  make check   TypeScript + Rust checks"
	@echo "  make lint    ESLint"
	@echo "  make clean   Remove build artifacts"
