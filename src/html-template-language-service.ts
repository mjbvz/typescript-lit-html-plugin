// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
//
// Original code forked from https://github.com/Quramy/ts-graphql-plugin

import * as ts from 'typescript/lib/tsserverlibrary';
import { getDocumentRegions } from './embeddedSupport';
import { LanguageService as HtmlLanguageService, FoldingRange } from 'vscode-html-languageservice';
import { getCSSLanguageService, LanguageService as cssLanguageService } from 'vscode-css-languageservice';
import * as vscode from 'vscode-languageserver-types';
import { TsHtmlPluginConfiguration } from './configuration';
import { TemplateLanguageService, TemplateContext, Logger } from 'typescript-template-language-service-decorator';
import { StyledTemplateLanguageService } from 'typescript-styled-plugin/lib/api';

const emptyCompletionList: vscode.CompletionList = {
    isIncomplete: false,
    items: [],
};

class CompletionsCache {
    private _cachedCompletionsFile?: string;
    private _cachedCompletionsPosition?: ts.LineAndCharacter;
    private _cachedCompletionsContent?: string;
    private _completions?: vscode.CompletionList;

    public getCached(
        context: TemplateContext,
        position: ts.LineAndCharacter
    ): vscode.CompletionList | undefined {
        if (this._completions
            && context.fileName === this._cachedCompletionsFile
            && this._cachedCompletionsPosition && arePositionsEqual(position, this._cachedCompletionsPosition)
            && context.text === this._cachedCompletionsContent
        ) {
            return this._completions;
        }

        return undefined;
    }

    public updateCached(
        context: TemplateContext,
        position: ts.LineAndCharacter,
        completions: vscode.CompletionList
    ) {
        this._cachedCompletionsFile = context.fileName;
        this._cachedCompletionsPosition = position;
        this._cachedCompletionsContent = context.text;
        this._completions = completions;
    }
}

export default class HtmlTemplateLanguageService implements TemplateLanguageService {
    private _cssLanguageService?: cssLanguageService;
    private _completionsCache = new CompletionsCache();

    constructor(
        private readonly typescript: typeof ts,
        private readonly configuration: TsHtmlPluginConfiguration,
        private readonly htmlLanguageService: HtmlLanguageService,
        private readonly styledLanguageService: StyledTemplateLanguageService,
        private readonly logger: Logger // tslint:disable-line
    ) { }

    private get cssLanguageService(): cssLanguageService {
        if (!this._cssLanguageService) {
            this._cssLanguageService = getCSSLanguageService();
        }
        return this._cssLanguageService;
    }

    public getCompletionsAtPosition(
        context: TemplateContext,
        position: ts.LineAndCharacter
    ): ts.CompletionInfo {
        const items = this.getCompletionItems(context, position);
        return translateCompletionItemsToCompletionInfo(this.typescript, items);
    }

    public getCompletionEntryDetails?(
        context: TemplateContext,
        position: ts.LineAndCharacter,
        name: string
    ): ts.CompletionEntryDetails {
        const items = this.getCompletionItems(context, position).items;
        const item = items.find(x => x.label === name);
        if (!item) {
            return {
                name,
                kind: this.typescript.ScriptElementKind.unknown,
                kindModifiers: '',
                tags: [],
                displayParts: toDisplayParts(name),
                documentation: [],
            };
        }
        return translateCompletionItemsToCompletionEntryDetails(this.typescript, item);
    }

    public getQuickInfoAtPosition(
        context: TemplateContext,
        position: ts.LineAndCharacter
    ): ts.QuickInfo | undefined {
        const htmlDoc = this.createVirtualDocument(context);
        const documentRegions = getDocumentRegions(this.htmlLanguageService, htmlDoc);
        const languageId = documentRegions.getLanguageAtPosition(position);

        let hover: vscode.Hover;
        switch (languageId) {
            case 'html':
                const html = this.htmlLanguageService.parseHTMLDocument(htmlDoc);
                hover = this.htmlLanguageService.doHover(htmlDoc, position, html);
                break;
            case 'css':
                return this.styledLanguageService.getQuickInfoAtPosition(context, position);
            default:
                hover = undefined;
                break;
        }

        if (hover) {
            return this.translateHover(hover, position, context, languageId);
        }
        return undefined;
    }

    public getFormattingEditsForRange(
        context: TemplateContext,
        start: number,
        end: number,
        settings: ts.EditorSettings
    ): ts.TextChange[] {
        if (!this.configuration.format.enabled) {
            return [];
        }

        const doc = this.createVirtualDocument(context);
        // Make sure we don't get rid of leading newline
        const leading = context.text.match(/^\s*\n/);
        if (leading) {
            start += leading[0].length;
        }

        // or any trailing newlines
        const trailing = context.text.match(/\n\s*$/);
        if (trailing) {
            end -= trailing[0].length;
        }

        if (end <= start) {
            return [];
        }

        const range = this.toVsRange(context, start, end);
        const edits = this.htmlLanguageService.format(doc, range, {
            tabSize: settings.tabSize,
            insertSpaces: !!settings.convertTabsToSpaces,
            wrapLineLength: 120,
            unformatted: '',
            contentUnformatted: 'pre,code,textarea',
            indentInnerHtml: false,
            preserveNewLines: true,
            maxPreserveNewLines: null,
            indentHandlebars: false,
            endWithNewline: false,
            extraLiners: 'head, body, /html',
            wrapAttributes: 'auto',
        });

        return edits.map(vsedit => {
            return {
                span: this.toTsSpan(context, vsedit.range),
                newText: vsedit.newText,
            };
        });
    }

    public getSignatureHelpItemsAtPosition(
        _context: TemplateContext,
        _position: ts.LineAndCharacter
    ) {
        // Html does not support sig help
        return undefined;
    }

    public getOutliningSpans(
        context: TemplateContext
    ): ts.OutliningSpan[] {
        const doc = this.createVirtualDocument(context);
        const ranges = this.htmlLanguageService.getFoldingRanges(doc);
        return ranges.map(range => this.translateOutliningSpan(context, range));
    }

    public getSemanticDiagnostics(
        context: TemplateContext
    ): ts.Diagnostic[] {
        return this.styledLanguageService.getSemanticDiagnostics(context);
    }

    public getSupportedCodeFixes(): number[] {
        return this.styledLanguageService.getSupportedCodeFixes();
    }

    public getCodeFixesAtPosition(
        context: TemplateContext,
        start: number,
        end: number,
        errorCodes: number[],
        format: ts.FormatCodeSettings
    ): ts.CodeAction[] {
        return this.styledLanguageService.getCodeFixesAtPosition(context, start, end, errorCodes, format);
    }

    private toVsRange(
        context: TemplateContext,
        start: number,
        end: number
    ): vscode.Range {
        return {
            start: context.toPosition(start),
            end: context.toPosition(end),
        };
    }

    private toTsSpan(
        context: TemplateContext,
        range: vscode.Range
    ): ts.TextSpan {
        const editStart = context.toOffset(range.start);
        const editEnd = context.toOffset(range.end);

        return {
            start: editStart,
            length: editEnd - editStart,
        };
    }

    private createVirtualDocument(
        context: TemplateContext
    ): vscode.TextDocument {
        const contents = context.text;
        return {
            uri: 'untitled://embedded.html',
            languageId: 'html',
            version: 1,
            getText: () => contents,
            positionAt: (offset: number) => {
                return context.toPosition(offset);
            },
            offsetAt: (p: vscode.Position) => {
                return context.toOffset(p);
            },
            lineCount: contents.split(/n/g).length + 1,
        };
    }

    private createCssVirtualDocument(
        context: TemplateContext
    ): vscode.TextDocument {
        const contents = context.text;
        return {
            uri: 'untitled://embedded.css',
            languageId: 'css',
            version: 1,
            getText: () => contents,
            positionAt: (offset: number) => {
                return context.toPosition(offset);
            },
            offsetAt: (p: vscode.Position) => {
                return context.toOffset(p);
            },
            lineCount: contents.split(/n/g).length + 1,
        };
    }

    private getCompletionItems(
        context: TemplateContext,
        position: ts.LineAndCharacter
    ): vscode.CompletionList {
        const cached = this._completionsCache.getCached(context, position);
        if (cached) {
            return cached;
        }

        const htmlDoc = this.createVirtualDocument(context);
        const documentRegions = getDocumentRegions(this.htmlLanguageService, htmlDoc);
        const languageId = documentRegions.getLanguageAtPosition(position);

        let completions: vscode.CompletionList;
        switch (languageId) {
            case 'html':
                const html = this.htmlLanguageService.parseHTMLDocument(htmlDoc);
                completions = this.htmlLanguageService.doComplete(htmlDoc, position, html) || emptyCompletionList;
                break;
            case 'css':
                const cssDoc = this.createCssVirtualDocument(context);
                const stylesheet = this.cssLanguageService.parseStylesheet(cssDoc);
                completions = this.cssLanguageService.doComplete(cssDoc, position, stylesheet) || emptyCompletionList;
                break;
            default:
                completions = emptyCompletionList;
                break;
        }

        this._completionsCache.updateCached(context, position, completions);
        return completions;
    }

    private translateHover(
        hover: vscode.Hover,
        position: ts.LineAndCharacter,
        context: TemplateContext,
        languageId: string
    ): ts.QuickInfo {
        const header: ts.SymbolDisplayPart[] = [];
        const docs: ts.SymbolDisplayPart[] = [];
        const convertPart = (hoverContents: typeof hover.contents) => {
            if (typeof hoverContents === 'string') {
                docs.push({ kind: 'unknown', text: hoverContents});
            } else if (Array.isArray(hoverContents)) {
                hoverContents.forEach(convertPart);
            } else {
                if (languageId === 'css') {
                    // When inside a <style> block and hovering over the first
                    // property (i.e. <style> a.myclass { ... } ) the value
                    // contains the <style> tag which looks very odd and is not
                    // consistent with hovers in html/css files. We therefore
                    // remove it and any additional spaces to give it a
                    // consistent look and feel.
                    const removeStyleDeclaration = hoverContents.value.replace(/(<style>\n)\s+/gi, '');
                    header.push({ kind: 'unknown', text: removeStyleDeclaration });
                } else {
                    header.push({ kind: 'unknown', text: hoverContents.value });
                }
            }
        };
        convertPart(hover.contents);
        const start = context.toOffset(hover.range ? hover.range.start : position);
        return {
            kind: this.typescript.ScriptElementKind.string,
            kindModifiers: '',
            textSpan: {
                start,
                length: hover.range ? context.toOffset(hover.range.end) - start : 1,
            },
            displayParts: header,
            documentation: docs,
            tags: [],
        };
    }

    private translateOutliningSpan(
        context: TemplateContext,
        range: FoldingRange
    ): ts.OutliningSpan {
        const startOffset = context.toOffset({ line: range.startLine, character: range.startCharacter || 0 });
        const endOffset = context.toOffset({ line: range.endLine, character: range.endCharacter || 0 });
        const span = {
            start: startOffset,
            length: endOffset - startOffset,
        };

        return {
            autoCollapse: false,
            kind: this.typescript.OutliningSpanKind.Code,
            bannerText: '',
            textSpan: span,
            hintSpan: span,
        };
    }

    private translateTextEditToFileTextChange(
        context: TemplateContext,
        textEdit: vscode.TextEdit
    ): ts.FileTextChanges {
        const start = context.toOffset(textEdit.range.start);
        const end = context.toOffset(textEdit.range.end);
        return {
            fileName: context.fileName,
            textChanges: [{
                newText: textEdit.newText,
                span: {
                    start,
                    length: end - start,
                },
            }],
        };
    }
}

function translateCompletionItemsToCompletionInfo(
    typescript: typeof ts,
    items: vscode.CompletionList
): ts.CompletionInfo {
    return {
        isGlobalCompletion: false,
        isMemberCompletion: false,
        isNewIdentifierLocation: false,
        entries: items.items.map(x => translateCompetionEntry(typescript, x)),
    };
}

function translateCompletionItemsToCompletionEntryDetails(
    typescript: typeof ts,
    item: vscode.CompletionItem
): ts.CompletionEntryDetails {
    return {
        name: item.label,
        kindModifiers: 'declare',
        kind: item.kind ? translateionCompletionItemKind(typescript, item.kind) : typescript.ScriptElementKind.unknown,
        displayParts: toDisplayParts(item.detail),
        documentation: toDisplayParts(item.documentation),
        tags: [],
    };
}

function translateCompetionEntry(
    typescript: typeof ts,
    item: vscode.CompletionItem
): ts.CompletionEntry {
    return {
        name: item.label,
        kindModifiers: '',
        kind: item.kind ? translateionCompletionItemKind(typescript, item.kind) : typescript.ScriptElementKind.unknown,
        sortText: '0',
    };
}

function translateionCompletionItemKind(
    typescript: typeof ts,
    kind: vscode.CompletionItemKind
): ts.ScriptElementKind {
    switch (kind) {
        case vscode.CompletionItemKind.Method:
            return typescript.ScriptElementKind.memberFunctionElement;
        case vscode.CompletionItemKind.Function:
            return typescript.ScriptElementKind.functionElement;
        case vscode.CompletionItemKind.Constructor:
            return typescript.ScriptElementKind.constructorImplementationElement;
        case vscode.CompletionItemKind.Field:
        case vscode.CompletionItemKind.Variable:
            return typescript.ScriptElementKind.variableElement;
        case vscode.CompletionItemKind.Class:
            return typescript.ScriptElementKind.classElement;
        case vscode.CompletionItemKind.Interface:
            return typescript.ScriptElementKind.interfaceElement;
        case vscode.CompletionItemKind.Module:
            return typescript.ScriptElementKind.moduleElement;
        case vscode.CompletionItemKind.Property:
            return typescript.ScriptElementKind.memberVariableElement;
        case vscode.CompletionItemKind.Unit:
        case vscode.CompletionItemKind.Value:
            return typescript.ScriptElementKind.constElement;
        case vscode.CompletionItemKind.Enum:
            return typescript.ScriptElementKind.enumElement;
        case vscode.CompletionItemKind.Keyword:
            return typescript.ScriptElementKind.keyword;
        case vscode.CompletionItemKind.Color:
            return typescript.ScriptElementKind.constElement;
        case vscode.CompletionItemKind.Reference:
            return typescript.ScriptElementKind.alias;
        case vscode.CompletionItemKind.File:
            return typescript.ScriptElementKind.moduleElement;
        case vscode.CompletionItemKind.Snippet:
        case vscode.CompletionItemKind.Text:
        default:
            return typescript.ScriptElementKind.unknown;
    }
}

function translateSeverity(
    typescript: typeof ts,
    severity: vscode.DiagnosticSeverity | undefined
): ts.DiagnosticCategory {
    switch (severity) {
        case vscode.DiagnosticSeverity.Information:
        case vscode.DiagnosticSeverity.Hint:
            return typescript.DiagnosticCategory.Message;

        case vscode.DiagnosticSeverity.Warning:
            return typescript.DiagnosticCategory.Warning;

        case vscode.DiagnosticSeverity.Error:
        default:
            return typescript.DiagnosticCategory.Error;
    }
}

function toDisplayParts(
    text: string | vscode.MarkupContent | undefined
): ts.SymbolDisplayPart[] {
    if (!text) {
        return [];
    }
    return [{
        kind: 'text',
        text: typeof text === 'string' ? text : text.value,
    }];
}

function arePositionsEqual(
    left: ts.LineAndCharacter,
    right: ts.LineAndCharacter
): boolean {
    return left.line === right.line && left.character === right.character;
}

function isAfter(
    left: vscode.Position,
    right: vscode.Position
): boolean {
    return right.line > left.line || (right.line === left.line && right.character >= left.character);
}

function overlaps(
    a: vscode.Range,
    b: vscode.Range
): boolean {
    return !isAfter(a.end, b.start) && !isAfter(b.end, a.start);
}