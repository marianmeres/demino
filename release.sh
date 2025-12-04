#!/bin/bash

# Version release script for Deno projects
# Usage: ./release.sh [major|minor|patch] [custom message]

set -e  # Exit on any error

# Check if version type is provided
if [ $# -eq 0 ]; then
    echo "Usage: $0 [major|minor|patch] [optional custom message]"
    exit 1
fi

VERSION_TYPE=$1
CUSTOM_MESSAGE=$2

# Validate version type
if [[ ! "$VERSION_TYPE" =~ ^(major|minor|patch)$ ]]; then
    echo "Error: Version type must be 'major', 'minor', or 'patch'"
    exit 1
fi

# Check if we're in a git repository
if [ ! -d ".git" ]; then
    echo "Error: Not in a git repository"
    exit 1
fi

# Check if deno.json exists
if [ ! -f "deno.json" ]; then
    echo "Error: deno.json not found"
    exit 1
fi

# Check if everything is committed
if [ -n "$(git status --porcelain)" ]; then
    echo "Error: You have uncommitted changes. Please commit all changes before releasing."
    git status --short
    exit 1
fi

# Check if we're on the main/master branch (optional safety check)
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [[ "$CURRENT_BRANCH" != "main" && "$CURRENT_BRANCH" != "master" ]]; then
    echo "Warning: You're not on main/master branch (current: $CURRENT_BRANCH)"
    read -p "Continue anyway? (y/N): " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

# Get current version from deno.json
CURRENT_VERSION=$(deno eval "console.log(JSON.parse(Deno.readTextFileSync('deno.json')).version)")
echo "Current version: $CURRENT_VERSION"

# Calculate new version
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT_VERSION"
case $VERSION_TYPE in
    major)
        MAJOR=$((MAJOR + 1))
        MINOR=0
        PATCH=0
        ;;
    minor)
        MINOR=$((MINOR + 1))
        PATCH=0
        ;;
    patch)
        PATCH=$((PATCH + 1))
        ;;
esac
NEW_VERSION="$MAJOR.$MINOR.$PATCH"

# Show what will happen and ask for confirmation
echo
echo "This will:"
echo "  - Bump **$VERSION_TYPE** version to $NEW_VERSION"
if [ -n "$CUSTOM_MESSAGE" ]; then
    echo "  - Create a git tag with message: 'Release: $NEW_VERSION ($CUSTOM_MESSAGE)'"
else
    echo "  - Create a git tag with message: 'Release: $NEW_VERSION'"
fi
echo "  - Push to remote repository"
echo
read -p "Continue? (y/N): " -n 1 -r
echo

if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Release cancelled."
    exit 0
fi

# Update version in deno.json
echo "Bumping $VERSION_TYPE version..."
deno eval "
const config = JSON.parse(Deno.readTextFileSync('deno.json'));
config.version = '$NEW_VERSION';
Deno.writeTextFileSync('deno.json', JSON.stringify(config, null, 2) + '\n');
"

# Commit the version change
if [ -n "$CUSTOM_MESSAGE" ]; then
    git add deno.json
    git commit -m "Release: $NEW_VERSION ($CUSTOM_MESSAGE)"
    git tag -a "v$NEW_VERSION" -m "Release: $NEW_VERSION ($CUSTOM_MESSAGE)"
else
    git add deno.json
    git commit -m "Release: $NEW_VERSION"
    git tag -a "v$NEW_VERSION" -m "Release: $NEW_VERSION"
fi

echo "Version bumped to: v$NEW_VERSION"

# Push everything including tags
echo "Pushing to remote..."
git push && git push --tags

echo "Release complete! New version: v$NEW_VERSION"