// Copyright (C) 2025-2026 UnionTech Software Technology Co., Ltd.
// SPDX-License-Identifier: Apache-2.0 OR LGPL-3.0-only OR GPL-2.0-only OR GPL-3.0-only

#pragma once

#include <QString>
#include <QStringList>
#include <QMap>
#include <QList>
#include <QPointer>
#include <QObject>

struct OutputPrimaryState {
    bool wasPrimary = false;
};

class SurfaceWrapper;

struct SurfaceBinding {
    QPointer<SurfaceWrapper> surface;
    QString originalOutputName;
    QPointF relativePosition;
    int surfaceState = 0;
};

class OutputConfigState : public QObject {
    Q_OBJECT
public:
    explicit OutputConfigState(QObject *parent = nullptr) : QObject(parent) {}
    ~OutputConfigState() = default;

    void markScreenAsPrimary(const QString &outputName);
    bool wasScreenPrimary(const QString &outputName) const;
    void clearOutputState(const QString &outputName);
    void recordCopyModeExit();
    bool shouldRestoreCopyMode() const;
    void clearCopyModeIntent();

    void recordSurfaceBinding(SurfaceWrapper *surface, const QString &originalOutputName,
                              const QPointF &relativePosition, int surfaceState);
    QList<SurfaceBinding> takeSurfaceBindings(const QString &outputName);
    bool hasSurfaceBindings(const QString &outputName) const;
    void clearSurfaceBindings(const QString &outputName);
    void cleanupStaleBindings(const QStringList &activeOutputNames);

private:
    QMap<QString, OutputPrimaryState> m_states;
    bool m_copyModeExited = false;
    QMap<QString, QList<SurfaceBinding>> m_surfaceBindings;
};

